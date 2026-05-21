<script lang="ts">
  import { onMount } from "svelte";

  import Pane, { type PaneHandle, type PaneSendTarget } from "./Pane.svelte";
  import { DEFAULT_SEND_OPTIONS, SendHistory, sendTextTo, type SendOptions } from "./send";
  import { createLayoutStore } from "./layout/store.svelte";
  import { PRESETS, threePanePreset } from "./layout/presets";
  import Splitter from "./layout/Splitter.svelte";
  import type { PaneId, PaneSpec, SplitterInfo } from "./layout/tree";
  import { createConfigStore } from "./config.svelte";
  import { onConfigChanged, type RelayConfig, type ThemeConfig } from "./config";
  import type { ITheme } from "@xterm/xterm";
  import {
    applySessionRules,
    clearAutosaveScrollback,
    deleteSession as deleteSessionRust,
    installAutosave,
    listSessions,
    loadSession as loadSessionRust,
    readAutosave,
    readAutosaveScrollback,
    readSessionScrollback,
    saveSession as saveSessionRust,
    serializeSession,
    writeAutosaveScrollback,
    writeSessionScrollback,
    type LayoutPayload,
    type SessionMetadata,
  } from "./sessions";
  import CommandPalette from "./palette/CommandPalette.svelte";
  import {
    buildActions,
    type PaletteAction,
    type PaletteHooks,
    type SettingsSection,
  } from "./palette/actions";
  import SettingsPanel from "./settings/SettingsPanel.svelte";
  import StatusBar from "./StatusBar.svelte";
  import PipeRulesPanel from "./pipe/PipeRulesPanel.svelte";
  import LogsPanel from "./logging/LogsPanel.svelte";
  import { pipeList, pipeToggle, type PipeRule } from "./pipe";
  import "./app-root.css";
  import "./layout/splitter.css";

  // Config-driven default for newly-minted panes. Resolved lazily so the
  // factory captures the *current* config snapshot — that way a user edit to
  // `defaultPane.command` flows into the next split / preset growth without
  // rebuilding the store.
  function configDefaultPaneSpec(label: string, id: PaneId): PaneSpec {
    const dp = config.current.defaultPane;
    return {
      id,
      label,
      command: dp.command,
      ...(dp.args.length > 0 && { args: dp.args }),
      ...(dp.cwd && { cwd: dp.cwd }),
      ...(Object.keys(dp.env).length > 0 && { env: dp.env }),
    };
  }

  // Config store comes first because the layout-store factory closes over
  // `configDefaultPaneSpec`. Both attach asynchronously in `onMount` — see
  // below — so the synchronous defaults here are just the boot state.
  const config = createConfigStore();

  // Single source of truth for the layout tree, pane specs, and focus. The
  // store wraps the pure transforms in `./layout/tree.ts` and exposes derived
  // `paneOrder` (DFS) which drives Cmd+1..N + send target labelling.
  const store = createLayoutStore(threePanePreset(), {
    defaultPaneSpec: configDefaultPaneSpec,
  });

  const DEFAULT_FONT_SIZE = 13;
  const MIN_FONT_SIZE = 8;
  const MAX_FONT_SIZE = 32;
  const FONT_STEP = 1;
  let fontSize: number = $state(DEFAULT_FONT_SIZE);

  function clampFontSize(n: number): number {
    return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, n));
  }

  /**
   * Map a `KeyboardEvent.code` like "Digit3" to `3`, returning `undefined`
   * for anything else. We use `code` rather than `key` for digit shortcuts
   * because `event.key` is layout- and Shift-dependent: on a US keyboard
   * Cmd+Shift+2 surfaces as `"@"`, not `"2"`, so a `parseInt(event.key, 10)`
   * gate would silently swallow the user's send-to-pane-2 keystroke.
   * `event.code` describes the physical key and is stable across layouts
   * and modifiers.
   */
  function digitFromCode(code: string): number | undefined {
    const m = /^Digit([1-9])$/.exec(code);
    return m ? Number.parseInt(m[1]!, 10) : undefined;
  }

  // Pane handles registered via `onregister`, keyed by pane id (not by PTY
  // id — the pane id is durable across restarts, the PTY id changes).
  // Plain object rather than $state because we read them at the moment of
  // action (keystroke / menu click); no view needs to re-render when they
  // change.
  const handles: Record<PaneId, PaneHandle> = {};

  // Scrollback bytes recovered from a previous session, awaiting the moment
  // the corresponding pane registers its handle. The replay path is one-way:
  // we drain on registration so a later restart of the same pane doesn't
  // re-inject stale history.
  const pendingScrollback = new Map<PaneId, Uint8Array>();

  let sendOptions: SendOptions = $state({ ...DEFAULT_SEND_OPTIONS });
  const history = new SendHistory();

  // Pipe rules mirror the Rust registry. Refreshed on panel open, after
  // every CRUD, and on session load. Drives the status-bar count and the
  // palette's per-rule toggle entries.
  let pipeRules: PipeRule[] = $state([]);

  // Session name surfaced in the status bar. Set when a named session is
  // saved or loaded; reset to empty when the user clears it.
  let currentSessionName: string = $state("");

  // Sync UI state ← config in two places, never via `$effect`:
  //
  //   1. Once after `config.attach()` resolves so the initial load
  //      (`~/.config/relay/config.toml`) populates the form-controlled
  //      values.
  //   2. From the `config:changed` listener installed in onMount so an
  //      external edit (hot reload) refreshes the same values.
  //
  // A reactive `$effect` on `config.current.*` would race with the
  // optimistic local writes from Cmd+=/Cmd+-/Cmd+0: each handler bumps
  // `fontSize` locally and then fires an async `config.update`. Between
  // the local bump and the config write resolving, the effect would
  // observe a stale `config.current.font.size` and snap `fontSize` back
  // to it — visibly flickering, and outright dropping the second of two
  // back-to-back Cmd+= presses.
  function syncFromConfig(cfg: RelayConfig): void {
    const targetFs = clampFontSize(cfg.font.size);
    if (fontSize !== targetFs) fontSize = targetFs;
    if (
      sendOptions.bracketedPaste !== cfg.send.bracketedPaste ||
      sendOptions.trailingNewline !== cfg.send.trailingNewline
    ) {
      sendOptions = {
        bracketedPaste: cfg.send.bracketedPaste,
        trailingNewline: cfg.send.trailingNewline,
      };
    }
  }

  /**
   * Translate the user-facing `config.theme.mode` (`"dark"` | `"light"`) into
   * an xterm `ITheme`. Kept minimal on purpose — full preset / custom palette
   * support is intentionally out of scope here; this is only the wiring that
   * makes the existing toggle actually take effect.
   */
  function themeFromConfig(theme: ThemeConfig): ITheme {
    if (theme.mode === "light") {
      return {
        background: "#ffffff",
        foreground: "#1a1a1a",
        cursor: "#1a1a1a",
        selectionBackground: "rgba(0, 0, 0, 0.15)",
      };
    }
    return {
      background: "#1f2125",
      foreground: "#f5f5f5",
      cursor: "#f5f5f5",
      selectionBackground: "rgba(255, 255, 255, 0.2)",
    };
  }

  // Derived xterm options. Re-computed on every config change because the
  // hot-reload listener writes `config.current` and we want the Terminal
  // component to pick up the new theme / family / scrollback without a
  // restart.
  const terminalTheme = $derived(themeFromConfig(config.current.theme));
  const fontFamily = $derived(config.current.font.family);
  const scrollback = $derived(config.current.scrollback.lines);

  /**
   * Persist a font-size change back to config so the next launch (and any
   * other window) sees it. Fire-and-forget: the visible update already
   * happened locally; the await is just for error logging.
   */
  function persistFontSize(size: number): void {
    if (config.current.font.size === size) return;
    void config
      .update({ font: { ...config.current.font, size } })
      .catch((e) => console.error("[app] persist font size failed", e));
  }

  /**
   * Build the current SessionData blob from the layout + send options. Used
   * both by autosave (visibilitychange / beforeunload) and Settings → Save
   * named session.
   */
  function snapshotSession(name = "") {
    const snap = store.exportSnapshot();
    return serializeSession(
      {
        tree: snap.tree,
        panes: snap.panes,
        focusedPaneId: snap.focusedPaneId,
        customLayouts: store.customLayouts,
      },
      sendOptions,
      pipeRules,
      name
    );
  }

  function applyLayoutPayload(layout: LayoutPayload): void {
    store.importSnapshot({
      tree: layout.tree,
      panes: layout.panes,
      focusedPaneId: layout.focusedPaneId,
      customLayouts: layout.customLayouts,
    });
  }

  /**
   * Encode + persist scrollback for every live pane. Called from the
   * autosave driver and from the palette's "Save session" action. Returns
   * the list of pane ids that were actually written so callers can record
   * them in `SessionData.scrollbackKeys`.
   *
   * When `persistOnExit` is OFF the function additionally wipes the
   * autosave-scrollback dir — that way a user who toggles the setting off
   * doesn't see ancient buffers reappear on the next restore.
   */
  async function persistScrollback(
    write: (paneId: string, bytes: Uint8Array, maxBytes: number) => Promise<void>,
    clear?: () => Promise<void>
  ): Promise<string[]> {
    if (!config.current.scrollback.persistOnExit) {
      if (clear) {
        try {
          await clear();
        } catch {
          /* best-effort */
        }
      }
      return [];
    }
    const max = config.current.scrollback.persistMaxBytes;
    const keys: string[] = [];
    const encoder = new TextEncoder();
    for (const id of store.paneOrder) {
      const handle = handles[id];
      if (!handle) continue;
      try {
        const text = handle.serialize();
        if (!text) continue;
        await write(id, encoder.encode(text), max);
        keys.push(id);
      } catch {
        // Per-pane failures shouldn't abort the rest of the dump.
      }
    }
    return keys;
  }

  /**
   * Replay scrollback bytes for each pane the previous session recorded.
   * Stash into `pendingScrollback` so `registerHandle` can flush them as
   * each restored pane reaches the "Terminal mounted" state.
   */
  async function loadAutosaveScrollbackInto(keys: readonly string[]): Promise<void> {
    if (keys.length === 0) return;
    for (const id of keys) {
      try {
        const bytes = await readAutosaveScrollback(id);
        if (bytes.length > 0) pendingScrollback.set(id, bytes);
      } catch {
        /* skip — missing scrollback is non-fatal */
      }
    }
  }

  // --- Command palette ---

  let paletteOpen: boolean = $state(false);
  let paletteActions: PaletteAction[] = $state([]);
  let sessionCatalog: SessionMetadata[] = $state([]);
  let settingsOpen: boolean = $state(false);
  let settingsSection: SettingsSection | null = $state(null);
  let pipePanelOpen: boolean = $state(false);
  let logsPanelOpen: boolean = $state(false);
  let logsPanelPaneId: string | null = $state(null);

  async function refreshPipeRules(): Promise<void> {
    try {
      pipeRules = await pipeList();
    } catch (e) {
      console.error("[app] pipe_list failed", e);
      pipeRules = [];
    }
  }

  async function refreshSessions(): Promise<void> {
    try {
      sessionCatalog = await listSessions();
    } catch {
      sessionCatalog = [];
    }
  }

  const paletteHooks: PaletteHooks = {
    async sendToPane(targetId) {
      await sendSelection(store.focusedPaneId, targetId);
    },
    async saveSession() {
      const name = window.prompt("Save session as:");
      if (!name) return;
      const trimmed = name.trim();
      if (!trimmed) return;
      // Dump scrollback under this name first; the JSON's
      // `scrollbackKeys` then advertises what's on disk to load() later.
      const keys = await persistScrollback((paneId, bytes, max) =>
        writeSessionScrollback(trimmed, paneId, bytes, max)
      );
      const data = snapshotSession(trimmed);
      data.scrollbackKeys = keys;
      await saveSessionRust(trimmed, data);
      currentSessionName = trimmed;
      await refreshSessions();
    },
    async loadSession(name) {
      const data = await loadSessionRust(name);
      if (!data?.layout) return;
      // Read scrollback into the pending map BEFORE we apply the layout,
      // so the freshly-mounted Pane handles drain straight into the
      // restored terminals.
      if (data.scrollbackKeys?.length) {
        for (const paneId of data.scrollbackKeys) {
          try {
            const bytes = await readSessionScrollback(name, paneId);
            if (bytes.length > 0) pendingScrollback.set(paneId, bytes);
          } catch {
            /* skip pane */
          }
        }
      }
      applyLayoutPayload(data.layout);
      if (data.sendOptions) {
        sendOptions = {
          bracketedPaste: data.sendOptions.bracketedPaste,
          trailingNewline: data.sendOptions.trailingNewline,
        };
      }
      // Push the session's recorded rules into the Rust dispatcher so the
      // pipe registry reflects what was saved. We pull the new list back
      // immediately so the status bar / palette refresh.
      if (Array.isArray(data.rules)) {
        await applySessionRules(data.rules);
        await refreshPipeRules();
      }
      currentSessionName = name;
    },
    async deleteSession(name) {
      await deleteSessionRust(name);
      if (currentSessionName === name) currentSessionName = "";
      await refreshSessions();
    },
    openSettings(section) {
      settingsSection = section ?? null;
      settingsOpen = true;
    },
    bumpFont(delta) {
      fontSize = clampFontSize(fontSize + delta * FONT_STEP);
      persistFontSize(fontSize);
    },
    resetFont() {
      fontSize = DEFAULT_FONT_SIZE;
      persistFontSize(fontSize);
    },
    openPipeRules() {
      pipePanelOpen = true;
    },
    openLogs(paneId) {
      logsPanelPaneId = paneId;
      logsPanelOpen = true;
    },
    async togglePipeRule(ruleId, enabled) {
      try {
        await pipeToggle(ruleId, enabled);
        await refreshPipeRules();
      } catch (e) {
        console.error("[app] pipe_toggle failed", e);
      }
    },
  };

  async function openPalette(): Promise<void> {
    await refreshSessions();
    await refreshPipeRules();
    paletteActions = buildActions({
      store,
      config: config.current,
      sessions: sessionCatalog,
      pipeRules,
      hooks: paletteHooks,
    });
    paletteOpen = true;
  }

  function closePalette(): void {
    paletteOpen = false;
  }

  // Viewport dimensions for the absolute-positioning layer. `bind:clientWidth`
  // is reactive, but its underlying `ResizeObserver` is stubbed in vitest
  // (tests/setup.ts) — so it stays at 0×0 in jsdom. That's fine: panes still
  // mount into the DOM (which is what every test asserts) but the visible
  // rects are all 0×0. The Pane component's safeFit handles a 0×0 xterm
  // container gracefully.
  let viewportW: number = $state(0);
  let viewportH: number = $state(0);
  const SLOT_GUTTER_PX = 2;

  const rects = $derived(store.rectsFor({ w: viewportW, h: viewportH }, SLOT_GUTTER_PX));
  const splitters = $derived(store.splittersFor({ w: viewportW, h: viewportH }, SLOT_GUTTER_PX));

  /**
   * Minimum pixel size a pane must keep along the drag axis. Conservative
   * enough that even a tiny terminal still fits a usable prompt; phase 4
   * can tighten this against the actual xterm cell metrics if needed.
   */
  const MIN_PANE_PX = 80;

  function onSplitterDrag(s: SplitterInfo, deltaPx: number): void {
    // Look up the split's current weights so the px → fraction conversion
    // uses up-to-date sibling sizes (drag may have already moved the bar in
    // a previous event this frame).
    const split = findSplit(s.splitId);
    if (!split) return;
    const a = split.children[s.leftIdx];
    const b = split.children[s.rightIdx];
    if (!a || !b) return;
    const total = split.children.reduce((sum, c) => sum + c.weight, 0);
    if (total <= 0 || s.parentAxisSize <= 0) return;
    const aPx = (a.weight / total) * s.parentAxisSize;
    const bPx = (b.weight / total) * s.parentAxisSize;
    // Clamp so neither sibling can drop below MIN_PANE_PX. Positive dx
    // shrinks left (a), negative shrinks right (b).
    let allowed = deltaPx;
    if (deltaPx > 0) allowed = Math.min(deltaPx, Math.max(0, aPx - MIN_PANE_PX));
    else allowed = Math.max(deltaPx, -Math.max(0, bPx - MIN_PANE_PX));
    if (allowed === 0) return;
    // deltaFraction here is a fraction of (a.weight + b.weight), which is
    // proportional to (aPx + bPx) px. See `adjustSplitWeights` for the math.
    const deltaFraction = allowed / (aPx + bPx);
    store.setSplitWeight(s.splitId, s.leftIdx, s.rightIdx, deltaFraction);
  }

  /**
   * Guard the close action: spec §5 requires at least one live pane. We
   * surface this as "no onclose handler" rather than an error so the Pane
   * component renders the close button as disabled instead of crashing on
   * click — the store's `closePane` enforces the same invariant defensively.
   */
  function canClose(): boolean {
    return store.paneOrder.length > 1;
  }

  /**
   * Drive the popover's "Move ←/→/↑/↓" buttons. Returns null when the pane
   * is the lone root leaf (no siblings to reorder against). The popover
   * uses the parent split's direction to pick row vs column arrow glyphs.
   */
  function reorderHintFor(paneId: PaneId) {
    const info = store.parentSplitOf(paneId);
    if (!info) return null;
    return {
      direction: info.direction,
      canPrev: info.idx > 0,
      canNext: info.idx < info.siblingCount - 1,
    };
  }

  function reorderPane(paneId: PaneId, delta: -1 | 1): void {
    const info = store.parentSplitOf(paneId);
    if (!info) return;
    const toIdx = info.idx + delta;
    if (toIdx < 0 || toIdx >= info.siblingCount) return;
    store.reorderSiblings(info.splitId, info.idx, toIdx);
  }

  // Layout menu state. Local to AppRoot — phase 4 keeps custom layouts in
  // memory; PR-15 will persist via session-save.
  let layoutMenuOpen: boolean = $state(false);

  function applyPresetAndClose(id: string): void {
    store.applyPreset(id);
    layoutMenuOpen = false;
  }

  function saveCurrentLayout(): void {
    const name = window.prompt("Save current layout as:");
    if (!name) return;
    store.saveCustomLayout(name.trim());
    layoutMenuOpen = false;
  }

  function applyCustomAndClose(name: string): void {
    store.applyCustomLayout(name);
    layoutMenuOpen = false;
  }

  function findSplit(splitId: string) {
    function visit(node: typeof store.tree): { children: { weight: number }[]; id: string } | null {
      if (node.kind === "leaf") return null;
      if (node.id === splitId) return node;
      for (const c of node.children) {
        const found = visit(c.node);
        if (found) return found;
      }
      return null;
    }
    return visit(store.tree);
  }

  /**
   * Read the selection from `source`, then deliver it to `target`'s PTY via
   * the Rust bridge. No-ops cleanly when either side isn't ready yet (still
   * spawning, exited, or selection is empty).
   */
  async function sendSelection(source: PaneId, target: PaneId): Promise<void> {
    if (source === target) return;
    const src = handles[source];
    const tgt = handles[target];
    if (!src || !tgt) return;
    const text = src.getSelection();
    if (!text) return;
    const targetPtyId = tgt.getPtyId();
    if (!targetPtyId) return;
    try {
      await sendTextTo(
        {
          text,
          targetPtyId,
          sourceLabel: src.label,
          targetLabel: tgt.label,
          options: sendOptions,
        },
        history,
        sendOptions
      );
      // Status bar surfaces "focused → target"; remember the target per
      // source so a follow-up focus jump still shows the prior pick.
      store.recordSend(source, target);
    } catch (e) {
      console.error("[page] pty_send_text failed", e);
    }
  }

  /**
   * Build the right-click "Send to" menu entries for `source`, in pane order
   * so the menu reflects the visual layout. The entries close over `source`
   * so picking one always sends from the pane the user right-clicked, not
   * from whichever pane happens to be focused.
   */
  function sendTargetsFor(source: PaneId): PaneSendTarget[] {
    return store.paneOrder
      .filter((id) => id !== source)
      .map<PaneSendTarget>((id) => {
        const spec = store.panes[id];
        return {
          label: spec ? spec.label : id,
          onSelect: () => {
            void sendSelection(source, id);
          },
        };
      });
  }

  function registerHandle(id: PaneId, handle: PaneHandle | undefined) {
    if (handle) {
      handles[id] = handle;
      // Drain any pending scrollback now that the Terminal API is alive.
      // Done on the next microtask so the replay lands after the
      // Terminal's own onMount has wired its addons.
      const pending = pendingScrollback.get(id);
      if (pending) {
        pendingScrollback.delete(id);
        queueMicrotask(() => {
          // The pane may have been closed between registration and this
          // microtask — re-check via the live map.
          handles[id]?.replay(pending);
        });
      }
    } else {
      delete handles[id];
    }
  }

  function handleKeydown(event: KeyboardEvent) {
    // All shortcuts in this app are Cmd-based; bail early on anything else
    // so unrelated typing (including ctrl-based zsh bindings inside the
    // terminal) is never preempted.
    if (!event.metaKey) return;
    if (event.ctrlKey || event.altKey) return;

    switch (event.code) {
      case "Equal":
        event.preventDefault();
        fontSize = clampFontSize(fontSize + FONT_STEP);
        persistFontSize(fontSize);
        return;
      case "Minus":
        event.preventDefault();
        fontSize = clampFontSize(fontSize - FONT_STEP);
        persistFontSize(fontSize);
        return;
      case "Digit0":
        event.preventDefault();
        fontSize = DEFAULT_FONT_SIZE;
        persistFontSize(fontSize);
        return;
    }

    const digit = digitFromCode(event.code);
    if (digit !== undefined) {
      const order = store.paneOrder;
      // Cmd+9 follows the tmux / iTerm convention: jump to the *last* pane,
      // however many there are. Cmd+1..8 index normally into the visual
      // top-left DFS order.
      const idx = digit === 9 ? order.length - 1 : digit - 1;
      const target = order[idx];
      if (target !== undefined) {
        event.preventDefault();
        if (event.shiftKey) {
          void sendSelection(store.focusedPaneId, target);
        } else {
          store.focus(target);
        }
        return;
      }
    }
    if (event.shiftKey) return;

    // Modal hotkeys are routed by `event.code` (physical key) for the same
    // layout-stability reason as Cmd+1..N. Cmd+P / Cmd+, are spec §13.
    switch (event.code) {
      case "KeyP":
        event.preventDefault();
        void openPalette();
        return;
      case "Comma":
        event.preventDefault();
        settingsSection = null;
        settingsOpen = true;
        return;
    }

    const focused = handles[store.focusedPaneId];
    switch (event.key) {
      case "k":
      case "K":
        event.preventDefault();
        focused?.clear();
        return;
      case "r":
      case "R":
        event.preventDefault();
        focused?.restart();
        return;
      case "f":
      case "F":
        event.preventDefault();
        focused?.openSearch();
        return;
    }
  }

  onMount(() => {
    window.addEventListener("keydown", handleKeydown);

    // Async bootstrap. Each step is wrapped so a missing IPC backend (the
    // Vitest mock returns undefined for everything) silently keeps the
    // synchronous defaults instead of breaking the mount.
    let unsubConfig: (() => void) | undefined;
    let unsubConfigEvent: (() => void) | undefined;
    let teardownAutosave: (() => void) | undefined;

    void (async () => {
      try {
        unsubConfig = await config.attach();
      } catch {
        /* stay on defaults */
      }
      // Initial sync: pull values out of the freshly-loaded config.
      syncFromConfig(config.current);
      // Hot-reload sync: react to the watcher's `config:changed` event.
      try {
        unsubConfigEvent = await onConfigChanged((cfg) => syncFromConfig(cfg));
      } catch {
        /* no live watcher available (e.g. tests) */
      }

      // Restore the previous session if the user has opted in (default on)
      // and an autosave file exists. Honoured before installing the new
      // listeners so an immediate quit doesn't overwrite the prior dump
      // with the boot snapshot.
      if (config.current.session.restoreOnLaunch) {
        try {
          const prev = await readAutosave();
          if (prev?.layout?.tree && prev.layout.panes) {
            // Stage scrollback BEFORE the panes mount so each handle
            // registration can drain its bytes.
            if (prev.scrollbackKeys?.length) {
              await loadAutosaveScrollbackInto(prev.scrollbackKeys);
            }
            applyLayoutPayload(prev.layout);
            if (prev.sendOptions) {
              // Session-recorded send options outrank the config copy — the
              // user explicitly chose them last run.
              sendOptions = {
                bracketedPaste: prev.sendOptions.bracketedPaste,
                trailingNewline: prev.sendOptions.trailingNewline,
              };
            }
            if (Array.isArray(prev.rules)) {
              await applySessionRules(prev.rules);
            }
          }
        } catch {
          /* ignore restore failures */
        }
      }

      await refreshPipeRules();

      teardownAutosave = installAutosave({
        snapshot: () => snapshotSession(),
        enabled: () => config.current.session.autosaveOnExit,
        persistScrollback: () =>
          persistScrollback(writeAutosaveScrollback, clearAutosaveScrollback),
      });
    })();

    return () => {
      window.removeEventListener("keydown", handleKeydown);
      unsubConfig?.();
      unsubConfigEvent?.();
      teardownAutosave?.();
      // Intentionally NO autosave write here — unmount also fires during
      // HMR / test cleanup, both of which would overwrite a legitimate
      // previous-session file with whatever ephemeral state the test had.
      // visibilitychange + beforeunload cover the real "user is leaving"
      // paths.
    };
  });
</script>

<div class="app-root">
  <div class="app-toolbar">
    <div class="layout-menu">
      <button
        type="button"
        class="layout-menu-toggle"
        aria-haspopup="menu"
        aria-expanded={layoutMenuOpen}
        onclick={() => (layoutMenuOpen = !layoutMenuOpen)}
        data-testid="layout-menu-toggle"
      >
        Layout ▾
      </button>
      {#if layoutMenuOpen}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="layout-menu-backdrop" onclick={() => (layoutMenuOpen = false)}>
          <ul
            class="layout-menu-list"
            data-testid="layout-menu-list"
            role="menu"
            onclick={(e) => e.stopPropagation()}
          >
            <li class="layout-menu-header">Preset</li>
            {#each PRESETS as preset (preset.id)}
              <li>
                <button
                  type="button"
                  role="menuitem"
                  onclick={() => applyPresetAndClose(preset.id)}
                  data-testid={`layout-menu-preset-${preset.id}`}
                >
                  {preset.label}
                </button>
              </li>
            {/each}
            <li class="layout-menu-divider"></li>
            <li class="layout-menu-header">Custom</li>
            <li>
              <button
                type="button"
                role="menuitem"
                onclick={saveCurrentLayout}
                data-testid="layout-menu-save"
              >
                Save current as…
              </button>
            </li>
            {#each store.listCustomLayouts() as name (name)}
              <li>
                <button
                  type="button"
                  role="menuitem"
                  onclick={() => applyCustomAndClose(name)}
                  data-testid={`layout-menu-custom-${name}`}
                >
                  {name}
                </button>
              </li>
            {/each}
          </ul>
        </div>
      {/if}
    </div>
  </div>
  <div class="layout" bind:clientWidth={viewportW} bind:clientHeight={viewportH}>
    {#each Object.values(store.panes) as pane (pane.id)}
      {@const r = rects[pane.id]}
      <div
        class="slot"
        class:detached={!r}
        style={r ? `left:${r.x}px; top:${r.y}px; width:${r.w}px; height:${r.h}px;` : ""}
      >
        <Pane
          label={pane.label}
          command={pane.command}
          args={pane.args}
          cwd={pane.cwd}
          env={pane.env}
          {fontSize}
          {fontFamily}
          {terminalTheme}
          {scrollback}
          focused={store.focusedPaneId === pane.id}
          onfocus={() => store.focus(pane.id)}
          sendTargets={sendTargetsFor(pane.id)}
          onregister={(h) => registerHandle(pane.id, h)}
          onclose={canClose() ? () => store.closePane(pane.id) : undefined}
          onsplit={(direction, position) => {
            const newId = store.splitPane(pane.id, direction, position);
            if (newId) store.focus(newId);
          }}
          onduplicate={() => {
            const newId = store.duplicatePane(pane.id, "row");
            if (newId) store.focus(newId);
          }}
          reorderHint={reorderHintFor(pane.id)}
          onreorder={(delta) => reorderPane(pane.id, delta)}
          onupdatemeta={(patch) => store.updatePaneMeta(pane.id, patch)}
        />
      </div>
    {/each}
    {#each splitters as s (s.id)}
      <Splitter
        direction={s.direction}
        x={s.x}
        y={s.y}
        length={s.length}
        ondrag={(dx) => onSplitterDrag(s, dx)}
      />
    {/each}
  </div>
  <StatusBar
    focusedLabel={store.panes[store.focusedPaneId]?.label ?? ""}
    sendTargetLabel={// Resolve the most recent send target for the focused source. The
    // status bar shows null when the user hasn't sent anything yet
    // (suppresses the "→" chip entirely).
    (() => {
      const tgt = store.lastSendTarget[store.focusedPaneId];
      return tgt ? (store.panes[tgt]?.label ?? null) : null;
    })()}
    activeRuleCount={pipeRules.filter((r) => r.enabled).length}
    sessionName={currentSessionName}
  />
  <CommandPalette open={paletteOpen} actions={paletteActions} onclose={closePalette} />
  <SettingsPanel
    open={settingsOpen}
    {config}
    initialSection={settingsSection}
    onclose={() => (settingsOpen = false)}
  />
  <PipeRulesPanel
    open={pipePanelOpen}
    panes={store.paneOrder.flatMap((id) => {
      const spec = store.panes[id];
      return spec ? [{ id, label: spec.label }] : [];
    })}
    onrulesChanged={(next) => {
      pipeRules = [...next];
    }}
    onclose={() => {
      pipePanelOpen = false;
      void refreshPipeRules();
    }}
  />
  <LogsPanel
    open={logsPanelOpen}
    paneId={logsPanelPaneId}
    paneLabel={logsPanelPaneId ? (store.panes[logsPanelPaneId]?.label ?? "") : ""}
    onclose={() => {
      logsPanelOpen = false;
      logsPanelPaneId = null;
    }}
  />
</div>
