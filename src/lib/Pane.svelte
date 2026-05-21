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
  // right now; clearing it instantly detaches the listeners from any
  // in-flight PTY (e.g. during restart). `destroyed` lets async continuations
  // after an `await` notice the component has unmounted and bail out.
  let currentPtyId: PtyId | undefined;
  let destroyed = false;
  let unlistenData: (() => void) | undefined;
  let unlistenExit: (() => void) | undefined;

  const encoder = new TextEncoder();

  async function installListeners() {
    // Listeners are installed once for the lifetime of the pane and filter
    // by `currentPtyId`, which is committed to a JS-allocated id *before*
    // we call spawnPty. That way any pty:data / pty:exit the bridge emits
    // between starting its forward task and the spawn IPC returning still
    // routes to us — short-lived processes (echo, programs that print
    // usage and exit) would otherwise lose their entire output.
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

    // Generate the id and commit `currentPtyId` *before* the network call.
    // From this point on, listeners route bridge-emitted events to us. The
    // id also doubles as a generation token: if another spawn() (or
    // restart()) has moved `currentPtyId` to a different value by the time
    // this `await spawnPty(cfg)` resumes, we must not mutate the pane
    // state — otherwise a stale success or failure would clobber the
    // newer session's spawning / running state.
    const id = crypto.randomUUID();
    currentPtyId = id;

    const cfg: PtySpawnConfig = { id, command, args, cwd, env };
    if (api) {
      cfg.cols = api.cols;
      cfg.rows = api.rows;
    }

    let spawnError: unknown;
    try {
      await spawnPty(cfg);
    } catch (e) {
      spawnError = e;
    }

    // Two reasons we might not be the active session any more:
    //   - the pane was unmounted
    //   - restart() / a later spawn() advanced `currentPtyId`
    // Either way, leave state mutations to the active session and clean up
    // any orphan PTY the backend spawned for us.
    if (destroyed || currentPtyId !== id) {
      if (!spawnError) {
        void killPty(id).catch(() => {
          // Best-effort — backend will GC on app exit anyway.
        });
      }
      return;
    }

    if (spawnError) {
      status = "error";
      errorMessage = spawnError instanceof Error ? spawnError.message : String(spawnError);
      currentPtyId = undefined;
      return;
    }

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

  // Keep xterm's real focus in sync with the `focused` prop. The parent
  // owns the focusedId state (initial load, click, future Cmd+1..N
  // keybindings), so we react to it here rather than relying on every
  // call site to also call api.focus().
  $effect(() => {
    if (focused && api) {
      api.focus();
    }
  });

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
