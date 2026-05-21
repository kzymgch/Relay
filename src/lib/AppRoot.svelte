<script lang="ts">
  import { onMount } from "svelte";

  import Pane, { type PaneHandle, type PaneSendTarget } from "./Pane.svelte";
  import { DEFAULT_SEND_OPTIONS, SendHistory, sendTextTo, type SendOptions } from "./send";
  import { createLayoutStore } from "./layout/store.svelte";
  import { PRESETS, threePanePreset } from "./layout/presets";
  import Splitter from "./layout/Splitter.svelte";
  import type { PaneId, PaneSpec, SplitterInfo } from "./layout/tree";
  import { createConfigStore } from "./config.svelte";
  import {
    deleteSession as deleteSessionRust,
    installAutosave,
    listSessions,
    loadSession as loadSessionRust,
    readAutosave,
    saveSession as saveSessionRust,
    serializeSession,
    type LayoutPayload,
    type SessionMetadata,
  } from "./sessions";
  import CommandPalette from "./palette/CommandPalette.svelte";
  import { buildActions, type PaletteAction, type PaletteHooks } from "./palette/actions";
  import SettingsPanel from "./settings/SettingsPanel.svelte";
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

  let sendOptions: SendOptions = $state({ ...DEFAULT_SEND_OPTIONS });
  const history = new SendHistory();

  // One-way sync from the config store into the reactive UI state. The
  // guards keep this idempotent — when Cmd+=/-/0 update config below, the
  // resulting reactive write here is a no-op so no flicker. External
  // edits to ~/.config/relay/config.toml (hot reload) flow through here
  // automatically.
  $effect(() => {
    const target = clampFontSize(config.current.font.size);
    if (fontSize !== target) fontSize = target;
  });
  $effect(() => {
    const next = config.current.send;
    if (
      sendOptions.bracketedPaste !== next.bracketedPaste ||
      sendOptions.trailingNewline !== next.trailingNewline
    ) {
      sendOptions = { bracketedPaste: next.bracketedPaste, trailingNewline: next.trailingNewline };
    }
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

  // --- Command palette ---

  let paletteOpen: boolean = $state(false);
  let paletteActions: PaletteAction[] = $state([]);
  let sessionCatalog: SessionMetadata[] = $state([]);
  let settingsOpen: boolean = $state(false);

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
      await saveSessionRust(trimmed, snapshotSession(trimmed));
      await refreshSessions();
    },
    async loadSession(name) {
      const data = await loadSessionRust(name);
      if (!data?.layout) return;
      applyLayoutPayload(data.layout);
      if (data.sendOptions) {
        sendOptions = {
          bracketedPaste: data.sendOptions.bracketedPaste,
          trailingNewline: data.sendOptions.trailingNewline,
        };
      }
    },
    async deleteSession(name) {
      await deleteSessionRust(name);
      await refreshSessions();
    },
    openSettings() {
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
  };

  async function openPalette(): Promise<void> {
    await refreshSessions();
    paletteActions = buildActions({
      store,
      config: config.current,
      sessions: sessionCatalog,
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
    let teardownAutosave: (() => void) | undefined;

    void (async () => {
      try {
        unsubConfig = await config.attach();
      } catch {
        /* stay on defaults */
      }
      // The two `$effect` blocks above mirror config → fontSize and
      // config → sendOptions, so no explicit assignment is needed here —
      // the await resolves, `config.current` updates, the effects fire.

      // Restore the previous session if the user has opted in (default on)
      // and an autosave file exists. Honoured before installing the new
      // listeners so an immediate quit doesn't overwrite the prior dump
      // with the boot snapshot.
      if (config.current.session.restoreOnLaunch) {
        try {
          const prev = await readAutosave();
          if (prev?.layout?.tree && prev.layout.panes) {
            applyLayoutPayload(prev.layout);
            if (prev.sendOptions) {
              // Session-recorded send options outrank the config copy — the
              // user explicitly chose them last run.
              sendOptions = {
                bracketedPaste: prev.sendOptions.bracketedPaste,
                trailingNewline: prev.sendOptions.trailingNewline,
              };
            }
          }
        } catch {
          /* ignore restore failures */
        }
      }

      teardownAutosave = installAutosave({
        snapshot: () => snapshotSession(),
        enabled: () => config.current.session.autosaveOnExit,
      });
    })();

    return () => {
      window.removeEventListener("keydown", handleKeydown);
      unsubConfig?.();
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
  <CommandPalette open={paletteOpen} actions={paletteActions} onclose={closePalette} />
  <SettingsPanel open={settingsOpen} {config} onclose={() => (settingsOpen = false)} />
</div>
