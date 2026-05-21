<script lang="ts">
  import { onMount } from "svelte";

  import Terminal from "./Terminal.svelte";
  import type { TerminalApi } from "./terminal";
  import {
    killPty,
    onPtyData,
    onPtyExit,
    resizePty,
    spawnPty,
    writePty,
    type PaneId as PtyId,
    type PtySpawnConfig,
  } from "./pty";
  import "./pane.css";

  type PaneStatus = "spawning" | "running" | "exited" | "error";

  interface Props {
    label: string;
    command: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
    focused?: boolean;
    onfocus?: () => void;
    /**
     * Close action. Disabled in the fixed three-pane layout; wired up in
     * PR-12 (`feat/pane-ops`).
     */
    onclose?: () => void;
  }

  let { label, command, args = [], cwd, env, focused = false, onfocus, onclose }: Props = $props();

  let status: PaneStatus = $state("spawning");
  let exitInfo: { code: number; success: boolean } | null = $state(null);
  let errorMessage: string | undefined = $state();
  let api: TerminalApi | undefined = $state();

  // Non-reactive bookkeeping. `currentPtyId` is the id our listeners route to
  // right now; setting it to `undefined` instantly detaches the listeners
  // from any in-flight PTY (e.g. during restart). `destroyed` lets async
  // continuations after `await` notice the component has unmounted and bail
  // out before installing listeners or registering a fresh PTY.
  let currentPtyId: PtyId | undefined;
  let destroyed = false;
  let unlistenData: (() => void) | undefined;
  let unlistenExit: (() => void) | undefined;

  const encoder = new TextEncoder();

  async function installListeners() {
    // Listeners are installed once for the lifetime of the pane and filter
    // by `currentPtyId`. This avoids losing the very first `pty:data` /
    // `pty:exit` from short-lived processes that race the JS subscription.
    const dataDispose = await onPtyData((id, data) => {
      if (id === currentPtyId) api?.write(data);
    });
    if (destroyed) {
      dataDispose();
      return false;
    }
    unlistenData = dataDispose;

    const exitDispose = await onPtyExit((id, code, success) => {
      if (id === currentPtyId) {
        status = "exited";
        exitInfo = { code, success };
      }
    });
    if (destroyed) {
      exitDispose();
      unlistenData?.();
      unlistenData = undefined;
      return false;
    }
    unlistenExit = exitDispose;
    return true;
  }

  async function spawn() {
    if (destroyed) return;
    status = "spawning";
    exitInfo = null;
    errorMessage = undefined;

    const cfg: PtySpawnConfig = { command, args, cwd, env };
    if (api) {
      cfg.cols = api.cols;
      cfg.rows = api.rows;
    }

    let id: PtyId;
    try {
      id = await spawnPty(cfg);
    } catch (e) {
      if (destroyed) return;
      status = "error";
      errorMessage = e instanceof Error ? e.message : String(e);
      return;
    }

    if (destroyed) {
      // The pane unmounted while we were waiting on the backend. Don't
      // attach the new id; tell the backend to drop the PTY too.
      void killPty(id).catch(() => {
        // Best-effort — backend will GC on app exit anyway.
      });
      return;
    }

    currentPtyId = id;
    status = "running";
  }

  async function init() {
    if (!(await installListeners())) return;
    await spawn();
  }

  function handleTerminalReady(a: TerminalApi) {
    api = a;
    void init();
  }

  function handleData(data: string) {
    if (currentPtyId && status === "running") {
      writePty(currentPtyId, encoder.encode(data)).catch((e: unknown) => {
        console.error("[pane] pty_write failed", e);
      });
    }
  }

  function handleResize(cols: number, rows: number) {
    if (currentPtyId && status === "running") {
      resizePty(currentPtyId, cols, rows).catch((e: unknown) => {
        console.error("[pane] pty_resize failed", e);
      });
    }
  }

  async function restart() {
    if (destroyed) return;
    // Detach listeners from the old PTY synchronously so its pending events
    // (including the imminent pty:exit from the kill) don't bleed into the
    // new pane state.
    const oldId = currentPtyId;
    currentPtyId = undefined;
    status = "spawning";
    exitInfo = null;
    errorMessage = undefined;

    if (oldId) {
      try {
        await killPty(oldId);
      } catch (e) {
        console.warn("[pane] kill during restart failed", e);
      }
    }
    if (destroyed) return;
    api?.clear();
    await spawn();
  }

  function handleFocusRequest(event?: Event) {
    // Don't steal focus when the user clicks header controls — they have
    // their own behavior.
    if (event && event.target instanceof Element) {
      if (event.target.closest(".pane-header .actions")) {
        return;
      }
    }
    onfocus?.();
    api?.focus();
  }

  onMount(() => {
    return () => {
      destroyed = true;
      unlistenData?.();
      unlistenExit?.();
      unlistenData = undefined;
      unlistenExit = undefined;
      const id = currentPtyId;
      currentPtyId = undefined;
      if (id) {
        killPty(id).catch(() => {
          // Best-effort cleanup; the backend will GC on app exit anyway.
        });
      }
    };
  });
</script>

<!-- The wrapper div is a passive focus selector. The real interactive surface
     is xterm.js's textarea inside; keyboard users reach panes via Tab into
     the terminal, and PR-09 adds Cmd+1..N. -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="pane" class:focused onclick={handleFocusRequest}>
  <header class="pane-header">
    <span class="label">{label}</span>
    <span class="status status-{status}" data-testid="pane-status">
      {#if status === "running"}
        ● running
      {:else if status === "spawning"}
        ◌ starting
      {:else if status === "exited"}
        ■ exited{#if exitInfo}
          (code {exitInfo.code}){/if}
      {:else if status === "error"}
        ⚠ error
      {/if}
    </span>
    <div class="actions">
      <button type="button" onclick={restart} title="Restart" aria-label="Restart pane">⟳</button>
      <button
        type="button"
        onclick={onclose}
        title="Close (PR-12 will wire this up)"
        aria-label="Close pane"
        disabled
      >
        ✕
      </button>
    </div>
  </header>

  <div class="pane-body">
    {#if status === "error"}
      <div class="pane-error" data-testid="pane-error">PTY error: {errorMessage ?? "unknown"}</div>
    {/if}
    <Terminal onready={handleTerminalReady} ondata={handleData} onresize={handleResize} />
  </div>
</div>
