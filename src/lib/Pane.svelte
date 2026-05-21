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
  import { onSshStatus, sshReconnect } from "./ssh";
  import type { SshTarget } from "./layout/tree";
  import "./pane.css";

  type PaneStatus =
    | "spawning"
    | "running"
    | "exited"
    | "error"
    | "connecting"
    | "reconnecting"
    | "disconnected";

  /**
   * Handle the parent uses to read a pane's live state without forcing the
   * pane to leak `currentPtyId` as a reactive. The parent calls these at the
   * moment of action (Cmd+Shift+N, context-menu pick) — there's no need for
   * Svelte fine-grained reactivity here.
   */
  export interface PaneHandle {
    label: string;
    /** Current PTY id, or `undefined` while spawning / after exit. */
    getPtyId(): string | undefined;
    /** Selected text in the embedded xterm, or `undefined` when nothing is selected. */
    getSelection(): string | undefined;
    /** Pull keyboard focus to the embedded terminal. */
    focus(): void;
    /** Clear the terminal buffer (Cmd+K). No-op if the terminal isn't ready. */
    clear(): void;
    /** Restart the PTY: kill, then respawn with the same config (Cmd+R). */
    restart(): void;
    /** Open the in-pane search bar and focus its input (Cmd+F). */
    openSearch(): void;
    /**
     * Serialise the terminal buffer (ANSI sequences included). Used by
     * session save when `config.scrollback.persistOnExit` is on. Returns
     * an empty string when the terminal hasn't initialised yet.
     */
    serialize(): string;
    /**
     * Replay raw bytes into the terminal (no PTY round-trip). Used by
     * session restore to bring back the previous run's scrollback before
     * the new PTY starts producing output.
     */
    replay(bytes: Uint8Array): void;
  }

  /** A "Send to" entry rendered in the pane's right-click menu. */
  export interface PaneSendTarget {
    label: string;
    onSelect: () => void;
  }

  /** Patch shape consumed by the settings popover's Save button. */
  export interface PaneMetaPatch {
    label?: string;
    command?: string;
    args?: string[];
    cwd?: string | undefined;
    env?: Record<string, string> | undefined;
  }

  interface Props {
    label: string;
    /** Local command. Required when `ssh` is absent; ignored when `ssh` is set. */
    command?: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
    /** When set, the pane is a remote SSH session instead of a local PTY. */
    ssh?: SshTarget;
    /**
     * Per-app font size in CSS pixels. Owned by AppRoot so Cmd+/- adjusts
     * every pane in lock-step; the settings GUI also writes here.
     */
    fontSize?: number;
    /** Font family, threaded from `config.font.family`. */
    fontFamily?: string;
    /** xterm theme object (background / foreground / cursor / ANSI palette). */
    terminalTheme?: import("@xterm/xterm").ITheme;
    /** Scrollback buffer line count, threaded from `config.scrollback.lines`. */
    scrollback?: number;
    focused?: boolean;
    onfocus?: () => void;
    /** Remove this pane (called by the header ✕ button and by PanesPanel
     *  via `store.closePane`). When `undefined` the header button is
     *  rendered disabled (e.g. when this is the lone remaining pane). */
    onclose?: () => void;
    /**
     * Send-to targets the parent populates with the other panes. When
     * undefined / empty, the right-click menu is suppressed entirely so the
     * native context menu still works in dev tooling scenarios.
     */
    sendTargets?: PaneSendTarget[];
    /**
     * Stable id of this pane, threaded into the embedded SelectionChip so its
     * DataTransfer payload carries the source pane id. Drop targets reject
     * same-source drops by comparing against their own `paneId`.
     */
    paneId?: string;
    /**
     * Called when a relay DnD payload is released over this pane. The
     * parent decides whether to open the SendPreviewModal or write
     * directly to the target PTY based on `config.send.previewBeforeSend`.
     */
    onsenddropped?: (info: { sourcePaneId: string; text: string }) => void;
    /**
     * Called on mount (with a live handle) and on unmount (with `undefined`).
     * Parents use the handle for keybindings (`Cmd+Shift+1..N`) and the
     * command palette without coupling to internal pane state.
     */
    onregister?: (handle: PaneHandle | undefined) => void;
  }

  let {
    label,
    command,
    args = [],
    cwd,
    env,
    ssh,
    fontSize,
    fontFamily,
    terminalTheme,
    scrollback,
    focused = false,
    onfocus,
    onclose,
    sendTargets = [],
    paneId,
    onsenddropped,
    onregister,
  }: Props = $props();

  /** MIME prefix used by SelectionChip drag sources for same-app DnD. */
  const SEND_DND_MIME = "application/x-relay-send";

  let status: PaneStatus = $state("spawning");
  let dropActive = $state(false);
  // ondragenter/leave flicker across child elements; track depth so the
  // highlight only clears once every nested enter has been matched.
  let dragDepth = 0;
  let exitInfo: { code: number; success: boolean } | null = $state(null);
  let errorMessage: string | undefined = $state();
  // 1-based once the reconnect supervisor takes over; 0 on the initial
  // connection or while the pane is in steady-state `running` / `connected`.
  let sshAttempt: number = $state(0);
  const isSsh = $derived(ssh !== undefined);
  let api: TerminalApi | undefined = $state();
  let menu: { x: number; y: number } | null = $state(null);
  let searchOpen: boolean = $state(false);
  let searchQuery: string = $state("");
  let searchInputEl: HTMLInputElement | undefined = $state();

  // Non-reactive bookkeeping. `currentPtyId` is the id our listeners route to
  // right now; clearing it instantly detaches the listeners from any
  // in-flight PTY (e.g. during restart). `destroyed` lets async continuations
  // after an `await` notice the component has unmounted and bail out.
  let currentPtyId: PtyId | undefined;
  let destroyed = false;
  let unlistenData: (() => void) | undefined;
  let unlistenExit: (() => void) | undefined;
  let unlistenSshStatus: (() => void) | undefined;

  // Debounced PTY-resize. xterm's FitAddon fires onResize on every container
  // size change — during a splitter drag that's once per pointermove, and
  // shells like zsh / vim flicker if pty_resize lands on every frame. We
  // coalesce to a trailing-edge 60ms timer so the IPC fires once per drag
  // settle. The 60ms window is short enough to feel instant after release
  // while broad enough to absorb a fast-moving drag (~16ms per frame).
  const RESIZE_DEBOUNCE_MS = 60;
  let resizeTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingResize: { cols: number; rows: number } | undefined;

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
        // Clear the live id so PaneHandle.getPtyId() returns undefined per
        // its contract. AppRoot's inter-pane send relies on this to cleanly
        // no-op when the target pane has exited — otherwise the stale id
        // would reach pty_send_text and the bridge would reject it as
        // "unknown pty id".
        currentPtyId = undefined;
      }
    });
    if (destroyed) {
      exitDispose();
      unlistenData?.();
      unlistenData = undefined;
      return false;
    }
    unlistenExit = exitDispose;

    // SSH lifecycle. Drives the indicator class and Reconnect-button
    // visibility. Local panes never see these events so the listener is
    // a no-op for them.
    const sshDispose = await onSshStatus((payload) => {
      if (payload.paneId !== currentPtyId) return;
      sshAttempt = payload.attempt;
      switch (payload.status) {
        case "connecting":
          status = "connecting";
          break;
        case "connected":
          status = "running";
          break;
        case "disconnected":
          status = "disconnected";
          break;
        case "reconnecting":
          status = "reconnecting";
          break;
      }
    });
    if (destroyed) {
      sshDispose();
      unlistenData?.();
      unlistenExit?.();
      unlistenData = undefined;
      unlistenExit = undefined;
      return false;
    }
    unlistenSshStatus = sshDispose;
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

    // SSH panes leave `command` / `args` / `cwd` / `env` off the spawn
    // config — the backend opens a remote shell over russh and the local
    // process-launching code path is bypassed entirely.
    const cfg: PtySpawnConfig = ssh
      ? {
          id,
          ssh: {
            host: ssh.host,
            ...(ssh.port !== undefined && { port: ssh.port }),
            ...(ssh.user !== undefined && { user: ssh.user }),
            ...(ssh.identityPath !== undefined && { identityPath: ssh.identityPath }),
            ...(ssh.sshConfigAlias !== undefined && { sshConfigAlias: ssh.sshConfigAlias }),
            ...(ssh.useKeychainPassword !== undefined && {
              useKeychainPassword: ssh.useKeychainPassword,
            }),
            ...(ssh.autoReconnect !== undefined && { autoReconnect: ssh.autoReconnect }),
          },
        }
      : { id, command, args, cwd, env };
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

    // For SSH panes the `ssh:status` listener has already advanced the
    // state to `connected` (mapped to `running`) — or further, if the
    // session has already disconnected. Don't clobber a real terminal
    // state by force-resetting to `running` here.
    if (!isSsh || status === "spawning") {
      status = "running";
    }
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
    if (!(currentPtyId && status === "running")) return;
    pendingResize = { cols, rows };
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const target = pendingResize;
      resizeTimer = undefined;
      pendingResize = undefined;
      // Re-check on the trailing edge — the PTY may have been killed
      // (restart, unmount) while we were waiting.
      if (!target || !currentPtyId || status !== "running") return;
      resizePty(currentPtyId, target.cols, target.rows).catch((e: unknown) => {
        console.error("[pane] pty_resize failed", e);
      });
    }, RESIZE_DEBOUNCE_MS);
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

  function isRelayDrag(event: DragEvent): boolean {
    return event.dataTransfer?.types.includes(SEND_DND_MIME) ?? false;
  }

  function handleDragEnter(event: DragEvent): void {
    if (!isRelayDrag(event)) return;
    event.preventDefault();
    dragDepth += 1;
    dropActive = true;
  }

  function handleDragOver(event: DragEvent): void {
    if (!isRelayDrag(event)) return;
    // Required for the browser to fire a drop event.
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "copy";
    }
  }

  function handleDragLeave(event: DragEvent): void {
    if (!isRelayDrag(event)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) dropActive = false;
  }

  function handleDrop(event: DragEvent): void {
    if (!isRelayDrag(event)) return;
    event.preventDefault();
    dragDepth = 0;
    dropActive = false;
    const raw = event.dataTransfer?.getData(SEND_DND_MIME);
    const text = event.dataTransfer?.getData("text/plain");
    if (!raw || !text) return;
    let payload: { sourcePaneId?: string } = {};
    try {
      payload = JSON.parse(raw) as { sourcePaneId?: string };
    } catch {
      return;
    }
    const sourcePaneId = payload.sourcePaneId;
    if (!sourcePaneId) return;
    // Reject same-pane drops — the source can't usefully send to itself and
    // the preview modal would show a meaningless "X → X" route.
    if (paneId && sourcePaneId === paneId) return;
    onsenddropped?.({ sourcePaneId, text });
  }

  function handleContextMenu(event: MouseEvent) {
    if (sendTargets.length === 0) return;
    // If there's no selection there's nothing to send; let the native menu
    // through so the user can still copy / paste etc.
    const selection = api?.getSelection();
    if (!selection) return;
    event.preventDefault();
    menu = { x: event.clientX, y: event.clientY };
  }

  function pickTarget(target: PaneSendTarget) {
    menu = null;
    target.onSelect();
  }

  function dismissMenu() {
    menu = null;
  }

  function openSearch() {
    searchOpen = true;
    // Focus the input on the next tick — the element only exists after the
    // {#if searchOpen} block renders.
    queueMicrotask(() => searchInputEl?.focus());
  }

  function closeSearch() {
    searchOpen = false;
    searchQuery = "";
    // Return focus to the terminal so keystrokes go to the shell again.
    api?.focus();
  }

  function searchSubmit(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeSearch();
      return;
    }
    if (event.key !== "Enter") return;
    event.preventDefault();
    if (!searchQuery) return;
    if (event.shiftKey) {
      api?.findPrevious(searchQuery);
    } else {
      api?.findNext(searchQuery);
    }
  }

  onMount(() => {
    const handle: PaneHandle = {
      // Captured by closure so callers always see the latest values without
      // the parent needing to subscribe to pane internals.
      get label() {
        return label;
      },
      getPtyId: () => currentPtyId,
      getSelection: () => api?.getSelection(),
      focus: () => api?.focus(),
      clear: () => api?.clear(),
      restart: () => {
        void restart();
      },
      openSearch,
      serialize: () => api?.serialize() ?? "",
      replay: (bytes: Uint8Array) => api?.write(bytes),
    };
    onregister?.(handle);
    return () => {
      destroyed = true;
      onregister?.(undefined);
      unlistenData?.();
      unlistenExit?.();
      unlistenSshStatus?.();
      unlistenData = undefined;
      unlistenExit = undefined;
      unlistenSshStatus = undefined;
      if (resizeTimer) {
        clearTimeout(resizeTimer);
        resizeTimer = undefined;
        pendingResize = undefined;
      }
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
<div
  class="pane"
  class:focused
  class:drop-active={dropActive}
  onclick={handleFocusRequest}
  oncontextmenu={handleContextMenu}
  ondragenter={handleDragEnter}
  ondragover={handleDragOver}
  ondragleave={handleDragLeave}
  ondrop={handleDrop}
>
  <header class="pane-header">
    <span class="label">{label}</span>
    <span class="status status-{status}" data-testid="pane-status">
      {#if status === "running"}
        ● {isSsh ? "connected" : "running"}
      {:else if status === "spawning"}
        ◌ starting
      {:else if status === "connecting"}
        ◌ connecting{#if sshAttempt > 0}
          (attempt {sshAttempt}){/if}
      {:else if status === "reconnecting"}
        ↻ reconnecting{#if sshAttempt > 0}
          (attempt {sshAttempt}){/if}
      {:else if status === "disconnected"}
        ◯ disconnected
      {:else if status === "exited"}
        ■ exited{#if exitInfo}
          (code {exitInfo.code}){/if}
      {:else if status === "error"}
        ⚠ error
      {/if}
    </span>
    <div class="actions">
      {#if isSsh && (status === "disconnected" || status === "reconnecting")}
        <button
          type="button"
          onclick={() => {
            const id = currentPtyId;
            if (id) sshReconnect(id).catch(() => undefined);
          }}
          title="Reconnect now"
          aria-label="Reconnect SSH session"
          data-testid="pane-ssh-reconnect"
        >
          ⤴
        </button>
      {/if}
      <button type="button" onclick={restart} title="Restart" aria-label="Restart pane">⟳</button>
      <button
        type="button"
        onclick={() => onclose?.()}
        title="Close pane"
        aria-label="Close pane"
        disabled={!onclose}
      >
        ✕
      </button>
    </div>
  </header>

  <div class="pane-body">
    {#if status === "error"}
      <div class="pane-error" data-testid="pane-error">PTY error: {errorMessage ?? "unknown"}</div>
    {/if}
    {#if searchOpen}
      <div class="pane-search" data-testid="pane-search">
        <input
          bind:this={searchInputEl}
          bind:value={searchQuery}
          type="text"
          placeholder="Find"
          aria-label="Find in pane"
          onkeydown={searchSubmit}
        />
        <button
          type="button"
          onclick={() => searchQuery && api?.findPrevious(searchQuery)}
          aria-label="Find previous"
          title="Previous (Shift+Enter)"
        >
          ↑
        </button>
        <button
          type="button"
          onclick={() => searchQuery && api?.findNext(searchQuery)}
          aria-label="Find next"
          title="Next (Enter)"
        >
          ↓
        </button>
        <button type="button" onclick={closeSearch} aria-label="Close search" title="Close (Esc)">
          ✕
        </button>
      </div>
    {/if}
    <Terminal
      {fontSize}
      {fontFamily}
      theme={terminalTheme}
      {scrollback}
      {paneId}
      sourceLabel={label}
      onready={handleTerminalReady}
      ondata={handleData}
      onresize={handleResize}
    />
  </div>

  {#if menu}
    <!-- Backdrop dismisses on click; the menu itself stops propagation so
         choosing a target doesn't immediately close before the handler fires. -->
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="pane-menu-backdrop" onclick={dismissMenu}>
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <ul
        class="pane-menu"
        data-testid="pane-send-menu"
        style="left: {menu.x}px; top: {menu.y}px"
        onclick={(e) => e.stopPropagation()}
      >
        <li class="pane-menu-header">Send to</li>
        {#each sendTargets as target (target.label)}
          <li>
            <button type="button" onclick={() => pickTarget(target)}>{target.label}</button>
          </li>
        {/each}
      </ul>
    </div>
  {/if}
</div>
