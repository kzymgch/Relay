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
  let ptyId: PtyId | undefined = $state();
  let unlistenData: (() => void) | undefined;
  let unlistenExit: (() => void) | undefined;

  const encoder = new TextEncoder();

  async function clearListeners() {
    unlistenData?.();
    unlistenExit?.();
    unlistenData = undefined;
    unlistenExit = undefined;
  }

  async function spawn() {
    status = "spawning";
    exitInfo = null;
    errorMessage = undefined;

    const cfg: PtySpawnConfig = { command, args, cwd, env };
    if (api) {
      cfg.cols = api.cols;
      cfg.rows = api.rows;
    }

    try {
      const id = await spawnPty(cfg);
      ptyId = id;
      status = "running";

      unlistenData = await onPtyData((emittedId, data) => {
        if (emittedId === id) {
          api?.write(data);
        }
      });
      unlistenExit = await onPtyExit((emittedId, code, success) => {
        if (emittedId === id) {
          status = "exited";
          exitInfo = { code, success };
        }
      });
    } catch (e) {
      status = "error";
      errorMessage = e instanceof Error ? e.message : String(e);
    }
  }

  function handleTerminalReady(a: TerminalApi) {
    api = a;
    void spawn();
  }

  function handleData(data: string) {
    if (ptyId && status === "running") {
      writePty(ptyId, encoder.encode(data)).catch((e: unknown) => {
        console.error("[pane] pty_write failed", e);
      });
    }
  }

  function handleResize(cols: number, rows: number) {
    if (ptyId && status === "running") {
      resizePty(ptyId, cols, rows).catch((e: unknown) => {
        console.error("[pane] pty_resize failed", e);
      });
    }
  }

  async function restart() {
    if (ptyId && status === "running") {
      try {
        await killPty(ptyId);
      } catch (e) {
        console.warn("[pane] kill during restart failed", e);
      }
    }
    await clearListeners();
    ptyId = undefined;
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
      const id = ptyId;
      void clearListeners();
      if (id && status === "running") {
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
