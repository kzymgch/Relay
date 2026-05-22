<script lang="ts">
  import { onMount } from "svelte";

  import Pane, { type PaneHandle, type PaneSendTarget } from "./Pane.svelte";
  import { DEFAULT_SEND_OPTIONS, SendHistory, sendTextTo, type SendOptions } from "./send";
  import { createLayoutStore } from "./layout/store.svelte";
  import { PRESETS, threePanePreset } from "./layout/presets";
  import Splitter from "./layout/Splitter.svelte";
  import type { PaneId, PaneSpec, SplitterInfo } from "./layout/tree";
  import { createConfigStore } from "./config.svelte";
  import { onConfigChanged, type RelayConfig } from "./config";
  import { resolveTheme } from "./theme/resolve";
  import { applyChromePalette } from "./theme/chrome";
  import { resolveKeybinds } from "./keybind/resolve";
  import { dispatchKey, shouldHandleInEditable } from "./keybind/dispatch";
  import SendPreviewModal from "./send/SendPreviewModal.svelte";
  import PanesPanel, { type PaneRow } from "./panes/PanesPanel.svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { getCurrentWebview, type DragDropEvent } from "@tauri-apps/api/webview";
  import { sendPtyText } from "./pty";
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

  /**
   * Pending send awaiting user confirmation. Populated by drag-drop, Cmd+Shift
   * keybindings, and palette send actions when `config.send.previewBeforeSend`
   * is on. `null` means no modal is shown.
   */
  let previewRequest: {
    sourcePaneId: PaneId;
    targetPaneId: PaneId;
    sourceLabel: string;
    targetLabel: string;
    text: string;
  } | null = $state(null);

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

  // Derived xterm + chrome options. Re-computed on every config change so the
  // hot-reload listener and the in-app settings form both propagate without a
  // restart. `applyChromePalette` is fired in a `$effect` below.
  const resolved = $derived(resolveTheme(config.current.theme));
  const terminalTheme = $derived(resolved.xterm);
  const fontFamily = $derived(config.current.font.family);
  const scrollback = $derived(config.current.scrollback.lines);
  // Resolved keybind map, recomputed whenever `config.keybind` changes.
  // Built once per config snapshot rather than per keystroke so handleKeydown
  // is a tight Map.get + matches() call on the hot path.
  const resolvedKeybinds = $derived(resolveKeybinds(config.current.keybind));

  // Apply chrome (CSS variables on :root) reactively. Browsers diff custom-
  // property writes, so re-setting an identical palette is a no-op.
  $effect(() => {
    if (typeof document === "undefined") return;
    applyChromePalette(resolved.chrome);
  });

  // Push the transparency flag to the Rust window-effects command. The async
  // call is fire-and-forget; failures (e.g. non-macOS, missing private API)
  // log without surfacing to the user, who only loses the visual effect.
  let lastVibrancy: boolean | undefined;
  $effect(() => {
    const enabled = config.current.theme.transparent;
    if (lastVibrancy === enabled) return;
    lastVibrancy = enabled;
    void invoke("set_window_vibrancy", { enabled }).catch((e) => {
      console.warn("[app] set_window_vibrancy failed", e);
    });
  });

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
  // PR-32: pane settings live in a tabbed modal opened from the toolbar
  // (was previously a per-pane popover that got clipped near the edges).
  let panesPanelOpen: boolean = $state(false);

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

  /**
   * Build the rows the `PanesPanel` modal renders, one per visible pane,
   * in DFS / Cmd+1..N order. `reorderHint` and `isSsh` come from the same
   * helpers that used to drive the per-pane gear popover, so the modal's
   * Move / Split / Close buttons behave identically to the old UI.
   */
  const paneRows = $derived.by((): PaneRow[] => {
    const rows: PaneRow[] = [];
    for (const id of store.paneOrder) {
      const spec = store.panes[id];
      if (!spec) continue;
      rows.push({
        id,
        label: spec.label,
        command: spec.command,
        args: spec.args,
        cwd: spec.cwd,
        env: spec.env,
        reorderHint: reorderHintFor(id),
        isSsh: spec.ssh !== undefined,
      });
    }
    return rows;
  });

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
   *
   * When `config.send.previewBeforeSend` is on, this opens the preview modal
   * and resolves after the user confirms / cancels. Otherwise it writes
   * directly to the target PTY using the current `sendOptions` defaults.
   */
  async function sendSelection(source: PaneId, target: PaneId): Promise<void> {
    if (source === target) return;
    const src = handles[source];
    const tgt = handles[target];
    if (!src || !tgt) return;
    const text = src.getSelection();
    if (!text) return;
    await routeSend({
      sourcePaneId: source,
      targetPaneId: target,
      sourceLabel: src.label,
      targetLabel: tgt.label,
      text,
    });
  }

  /**
   * Drop handler — selection text arrives via DnD with the source pane id
   * already stamped on the DataTransfer. We resolve labels via the live
   * handle registry so the modal renders the up-to-date pane names.
   */
  function handleSendDropped(sourcePaneId: PaneId, targetPaneId: PaneId, text: string): void {
    if (sourcePaneId === targetPaneId) return;
    const src = handles[sourcePaneId];
    const tgt = handles[targetPaneId];
    if (!tgt) return;
    void routeSend({
      sourcePaneId,
      targetPaneId,
      sourceLabel: src?.label ?? sourcePaneId,
      targetLabel: tgt.label,
      text,
    });
  }

  async function routeSend(req: {
    sourcePaneId: PaneId;
    targetPaneId: PaneId;
    sourceLabel: string;
    targetLabel: string;
    text: string;
  }): Promise<void> {
    if (config.current.send.previewBeforeSend) {
      previewRequest = req;
      return;
    }
    await deliverSend(req, sendOptions);
  }

  async function deliverSend(
    req: {
      sourcePaneId: PaneId;
      targetPaneId: PaneId;
      sourceLabel: string;
      targetLabel: string;
      text: string;
    },
    options: SendOptions
  ): Promise<void> {
    const tgt = handles[req.targetPaneId];
    if (!tgt) return;
    const targetPtyId = tgt.getPtyId();
    if (!targetPtyId) return;
    try {
      await sendTextTo(
        {
          text: req.text,
          targetPtyId,
          sourceLabel: req.sourceLabel,
          targetLabel: req.targetLabel,
          options,
        },
        history,
        sendOptions
      );
      // Status bar surfaces "focused → target"; remember the target per
      // source so a follow-up focus jump still shows the prior pick.
      store.recordSend(req.sourcePaneId, req.targetPaneId);
    } catch (e) {
      console.error("[page] pty_send_text failed", e);
    }
  }

  function confirmPreview(options: SendOptions): void {
    const req = previewRequest;
    previewRequest = null;
    if (!req) return;
    void deliverSend(req, options);
  }

  function cancelPreview(): void {
    previewRequest = null;
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

  function focusPaneByIndex(idx1: number): boolean {
    const order = store.paneOrder;
    // Cmd+9 follows the tmux / iTerm convention: jump to the *last* pane,
    // however many there are. Cmd+1..8 index normally into the visual
    // top-left DFS order.
    const idx = idx1 === 9 ? order.length - 1 : idx1 - 1;
    const target = order[idx];
    if (target === undefined) return false;
    store.focus(target);
    return true;
  }

  function sendSelectionByIndex(idx1: number): boolean {
    const order = store.paneOrder;
    const idx = idx1 === 9 ? order.length - 1 : idx1 - 1;
    const target = order[idx];
    if (target === undefined) return false;
    void sendSelection(store.focusedPaneId, target);
    return true;
  }

  function bumpFontBy(delta: number): void {
    fontSize = clampFontSize(fontSize + delta);
    persistFontSize(fontSize);
  }

  function resetFont(): void {
    fontSize = DEFAULT_FONT_SIZE;
    persistFontSize(fontSize);
  }

  /**
   * Action.id → handler. Returns `false` when the action declined to fire
   * (e.g. focus pane 7 when only 3 panes exist), so the dispatcher can let
   * the keystroke fall through to the terminal. Returns `true` to
   * preventDefault and stop.
   */
  function handlersFor(): Record<string, () => boolean> {
    const focused = handles[store.focusedPaneId];
    const handlers: Record<string, () => boolean> = {
      "view.font.larger": () => {
        bumpFontBy(+FONT_STEP);
        return true;
      },
      "view.font.smaller": () => {
        bumpFontBy(-FONT_STEP);
        return true;
      },
      "view.font.reset": () => {
        resetFont();
        return true;
      },
      "palette.open": () => {
        void openPalette();
        return true;
      },
      "settings.open": () => {
        settingsSection = null;
        settingsOpen = true;
        return true;
      },
      "pane.clear": () => {
        focused?.clear();
        return true;
      },
      "pane.restart": () => {
        focused?.restart();
        return true;
      },
      "pane.search": () => {
        focused?.openSearch();
        return true;
      },
    };
    for (let i = 1; i <= 9; i++) {
      const n = i;
      handlers[`pane.focus.${n}`] = () => focusPaneByIndex(n);
      handlers[`send.to.${n}`] = () => sendSelectionByIndex(n);
    }
    return handlers;
  }

  function handleKeydown(event: KeyboardEvent) {
    // No early modifier filter: the user can bind any key (Ctrl-based,
    // bare F-keys, modifier-less digits). dispatchKey iterates the action
    // registry once and bails when nothing matches.
    //
    // Skip when the event lands on an editable element (xterm's textarea,
    // settings inputs, search box) and the combo would otherwise hijack a
    // printable keystroke — `shouldHandleInEditable` encodes that rule.
    if (!shouldHandleInEditable(event)) return;
    const actionId = dispatchKey(event, resolvedKeybinds);
    if (!actionId) return;
    const handler = handlersFor()[actionId];
    if (!handler) return;
    const fired = handler();
    if (fired) {
      event.preventDefault();
    }
  }

  // --- External file drag-and-drop ---

  let externalDropHoverEl: HTMLElement | null = null;

  function setExternalDropHover(el: HTMLElement | null): void {
    if (el === externalDropHoverEl) return;
    externalDropHoverEl?.classList.remove("drop-active");
    externalDropHoverEl = el;
    externalDropHoverEl?.classList.add("drop-active");
  }

  function clearExternalDropHover(): void {
    setExternalDropHover(null);
  }

  /** POSIX-safe single-quote wrap. Escapes any embedded single-quote by
   *  closing, inserting a literal escaped quote, and reopening. Safe to
   *  paste into bash/zsh/sh as a single token. */
  function shellQuote(s: string): string {
    return `'${s.replace(/'/g, `'\\''`)}'`;
  }

  /** True while any Modal (settings, pipe rules, palette, send preview…)
   *  is showing. We detect this via the DOM rather than enumerating every
   *  modal state because the Modal component centralises that contract —
   *  this stays correct even when future modals are added. */
  function isModalOpen(): boolean {
    return document.querySelector(".modal-backdrop") !== null;
  }

  function paneAtPoint(physicalX: number, physicalY: number): HTMLElement | null {
    const dpr = window.devicePixelRatio || 1;
    const cssX = physicalX / dpr;
    const cssY = physicalY / dpr;
    const hit = document.elementFromPoint(cssX, cssY);
    if (!(hit instanceof HTMLElement)) return null;
    // Match the `.pane` wrapper specifically. SelectionChip also stamps a
    // `data-pane-id` on itself (so its internal drag payload carries the
    // pane id), so a plain `[data-pane-id]` selector would land on the
    // chip when the cursor hovers it — the resolved id would still be
    // correct, but the drop-active highlight would attach to the small
    // chip overlay instead of the pane wrapper, leaving most of the pane
    // un-highlighted.
    const pane = hit.closest(".pane[data-pane-id]");
    return pane instanceof HTMLElement ? pane : null;
  }

  async function handleExternalDrop(payload: DragDropEvent): Promise<void> {
    if (payload.type === "leave") {
      clearExternalDropHover();
      return;
    }
    // While a modal is open its full-window backdrop covers every pane,
    // so a drop on what the user sees as "the dialog" would otherwise
    // fall through to the terminal underneath (or — worse — to the
    // focused pane via the fallback below) and silently paste a path the
    // user never targeted. Suppress drag-drop entirely in that mode.
    if (isModalOpen()) {
      clearExternalDropHover();
      return;
    }
    if (payload.type === "enter" || payload.type === "over") {
      const el = paneAtPoint(payload.position.x, payload.position.y);
      setExternalDropHover(el);
      return;
    }
    // drop
    clearExternalDropHover();
    if (!payload.paths || payload.paths.length === 0) return;
    const pane = paneAtPoint(payload.position.x, payload.position.y);
    // Resolve the target pane: explicit drop location wins; otherwise fall
    // back to the focused pane so a drop on the toolbar / status bar /
    // splitter still ends up somewhere reasonable. (Modal-open case is
    // handled above so the fallback can't surprise the user.)
    const targetId = pane?.dataset.paneId ?? store.focusedPaneId;
    if (!targetId) return;
    const targetHandle = handles[targetId];
    if (!targetHandle) return;
    const targetPtyId = targetHandle.getPtyId();
    if (!targetPtyId) return;
    // Focus the target so the user can immediately keep typing into the
    // line that now contains the path(s).
    if (store.focusedPaneId !== targetId) store.focus(targetId);
    const text = payload.paths.map(shellQuote).join(" ");
    try {
      // Bracketed paste so the shell treats the (possibly multi-byte)
      // path as a single literal token; no trailing newline so the user
      // can edit / extend the line before pressing Enter.
      await sendPtyText(targetPtyId, text, true, false);
    } catch (e) {
      console.error("[app] file drop send failed", e);
    }
  }

  onMount(() => {
    window.addEventListener("keydown", handleKeydown);

    // Async bootstrap. Each step is wrapped so a missing IPC backend (the
    // Vitest mock returns undefined for everything) silently keeps the
    // synchronous defaults instead of breaking the mount.
    let unsubConfig: (() => void) | undefined;
    let unsubConfigEvent: (() => void) | undefined;
    let unsubFileDrop: (() => void) | undefined;
    let teardownAutosave: (() => void) | undefined;

    // External file drag-and-drop. Tauri 2 windows default to
    // `dragDropEnabled: true`, which intercepts native file drops at the
    // OS layer — so the per-pane DOM `ondrop` (which only accepts the
    // relay-internal `application/x-relay-send` MIME) never sees them.
    // We subscribe at the webview level and route the path(s) into the
    // pane the cursor is over, shell-quoted and bracketed-pasted so the
    // shell treats them as a single literal token the user can edit.
    //
    // Position from Tauri is in physical pixels; `elementFromPoint` wants
    // CSS pixels, so we divide by devicePixelRatio.
    try {
      void getCurrentWebview()
        .onDragDropEvent((event) => {
          void handleExternalDrop(event.payload);
        })
        .then((un) => {
          unsubFileDrop = un;
        })
        .catch(() => {
          /* tests / non-Tauri host: no webview-level events */
        });
    } catch {
      /* getCurrentWebview throws if invoked outside a Tauri webview */
    }

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
      unsubFileDrop?.();
      clearExternalDropHover();
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
    <button
      type="button"
      class="layout-menu-toggle"
      onclick={() => (panesPanelOpen = true)}
      data-testid="panes-toolbar-toggle"
      title="Pane settings"
    >
      Pane Settings
    </button>
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
          ssh={pane.ssh}
          {fontSize}
          {fontFamily}
          {terminalTheme}
          {scrollback}
          focused={store.focusedPaneId === pane.id}
          onfocus={() => store.focus(pane.id)}
          sendTargets={sendTargetsFor(pane.id)}
          paneId={pane.id}
          onsenddropped={(info) => handleSendDropped(info.sourcePaneId, pane.id, info.text)}
          onregister={(h) => registerHandle(pane.id, h)}
          onclose={canClose() ? () => store.closePane(pane.id) : undefined}
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
  <SendPreviewModal
    open={previewRequest !== null}
    sourceLabel={previewRequest?.sourceLabel ?? ""}
    targetLabel={previewRequest?.targetLabel ?? ""}
    text={previewRequest?.text ?? ""}
    defaults={sendOptions}
    onconfirm={confirmPreview}
    oncancel={cancelPreview}
  />
  <PanesPanel
    open={panesPanelOpen}
    panes={paneRows}
    initialPaneId={store.focusedPaneId}
    canClose={canClose()}
    onupdatemeta={(paneId, patch) => store.updatePaneMeta(paneId, patch)}
    onsplit={(paneId, direction, position) => {
      const newId = store.splitPane(paneId, direction, position);
      if (newId) store.focus(newId);
    }}
    onduplicate={(paneId) => {
      const newId = store.duplicatePane(paneId, "row");
      if (newId) store.focus(newId);
    }}
    onreorder={(paneId, delta) => reorderPane(paneId, delta)}
    onclosepane={(paneId) => store.closePane(paneId)}
    onclose={() => (panesPanelOpen = false)}
  />
</div>
