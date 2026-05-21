// Command-palette action registry.
//
// Actions are produced fresh each time the palette opens — that way the
// list always reflects the *current* layout (pane labels), session catalog,
// custom layouts, etc. Callbacks close over the supplied refs so picking an
// action mutates the live store, not a stale snapshot.

import { PRESETS } from "../layout/presets";
import type { LayoutStore } from "../layout/store.svelte";
import type { RelayConfig } from "../config";
import type { PipeRule } from "../pipe";
import type { SessionMetadata } from "../sessions";
import { sshReconnect } from "../ssh";

export type PaletteGroup =
  | "pane"
  | "layout"
  | "session"
  | "send"
  | "view"
  | "settings"
  | "pipe"
  | "logs";

export interface PaletteAction {
  id: string;
  label: string;
  group: PaletteGroup;
  /** Right-hand keyboard hint or detail text. */
  hint?: string;
  run(): void | Promise<void>;
}

/** Section ids understood by `SettingsPanel.initialSection`. */
export type SettingsSection =
  | "font"
  | "send"
  | "scrollback"
  | "session"
  | "default-pane"
  | "pane-presets"
  | "theme"
  | "keybind"
  | "logging"
  | "import-export";

export interface PaletteHooks {
  /** Send the focused pane's current selection to `targetId`. */
  sendToPane(targetId: string): Promise<void>;
  /** Persist the current layout as a named session (prompts for a name). */
  saveSession(): Promise<void>;
  /** Load a named session into the live store. */
  loadSession(name: string): Promise<void>;
  /** Delete a named session from disk. */
  deleteSession(name: string): Promise<void>;
  /**
   * Open the in-app settings panel. When `section` is given, the panel
   * scrolls that section into view so the palette's "Settings: Font / Send
   * / …" entries deep-link.
   */
  openSettings(section?: SettingsSection): void;
  /** Bump font size by `delta` (positive = larger). */
  bumpFont(delta: number): void;
  /** Reset font size to its default. */
  resetFont(): void;
  /** Open the pipe-rules modal (CRUD lives there, not in Settings). */
  openPipeRules(): void;
  /** Open the live-log tail for `paneId`. */
  openLogs(paneId: string): void;
  /** Flip a pipe rule's enabled flag through the Rust dispatcher. */
  togglePipeRule(ruleId: string, enabled: boolean): Promise<void>;
}

export interface BuildActionsInput {
  store: LayoutStore;
  config: RelayConfig;
  sessions: readonly SessionMetadata[];
  /** Pipe rules already loaded from the Rust registry; surfaced as
   *  per-rule toggle entries in the palette. */
  pipeRules: readonly PipeRule[];
  hooks: PaletteHooks;
}

/**
 * Build the full action set in one pass. Returned in a stable order:
 * pane operations → layout presets → session ops → send-to targets → view
 * → settings. The palette sorts by fuzzy score within each open, so this
 * order only matters for the empty-query view.
 */
export function buildActions(input: BuildActionsInput): PaletteAction[] {
  const { store, config, sessions, pipeRules, hooks } = input;
  const out: PaletteAction[] = [];
  const focusedId = store.focusedPaneId;
  const focused = store.panes[focusedId];

  // --- Pane operations ---
  for (const id of store.paneOrder) {
    const spec = store.panes[id];
    if (!spec) continue;
    out.push({
      id: `pane.focus.${id}`,
      label: `Focus: ${spec.label}`,
      group: "pane",
      hint: id === focusedId ? "(current)" : undefined,
      run: () => store.focus(id),
    });
    if (spec.ssh) {
      out.push({
        id: `pane.ssh.reconnect.${id}`,
        label: `Reconnect SSH: ${spec.label}`,
        group: "pane",
        hint: spec.ssh.host,
        run: () => sshReconnect(id).catch(() => undefined),
      });
    }
  }
  if (focused) {
    out.push({
      id: "pane.split.right",
      label: `Split right: ${focused.label}`,
      group: "pane",
      run: () => {
        const newId = store.splitPane(focusedId, "row", "after");
        if (newId) store.focus(newId);
      },
    });
    out.push({
      id: "pane.split.down",
      label: `Split down: ${focused.label}`,
      group: "pane",
      run: () => {
        const newId = store.splitPane(focusedId, "column", "after");
        if (newId) store.focus(newId);
      },
    });
    if (store.paneOrder.length > 1) {
      out.push({
        id: "pane.close",
        label: `Close pane: ${focused.label}`,
        group: "pane",
        run: () => {
          store.closePane(focusedId);
        },
      });
    }
  }

  // --- Layout presets + custom layouts ---
  for (const preset of PRESETS) {
    out.push({
      id: `layout.preset.${preset.id}`,
      label: `Layout: ${preset.label}`,
      group: "layout",
      run: () => store.applyPreset(preset.id),
    });
  }
  for (const name of store.listCustomLayouts()) {
    out.push({
      id: `layout.custom.${name}`,
      label: `Layout: ${name}`,
      group: "layout",
      hint: "custom",
      run: () => store.applyCustomLayout(name),
    });
  }

  // --- Send targets ---
  for (const id of store.paneOrder) {
    if (id === focusedId) continue;
    const spec = store.panes[id];
    if (!spec) continue;
    out.push({
      id: `send.${id}`,
      label: `Send selection to ${spec.label}`,
      group: "send",
      run: () => hooks.sendToPane(id),
    });
  }

  // --- Sessions ---
  out.push({
    id: "session.save",
    label: "Save session as…",
    group: "session",
    run: () => hooks.saveSession(),
  });
  for (const meta of sessions) {
    out.push({
      id: `session.load.${meta.name}`,
      label: `Load session: ${meta.name}`,
      group: "session",
      hint: `${meta.paneCount} pane${meta.paneCount === 1 ? "" : "s"}`,
      run: () => hooks.loadSession(meta.name),
    });
    out.push({
      id: `session.delete.${meta.name}`,
      label: `Delete session: ${meta.name}`,
      group: "session",
      run: () => hooks.deleteSession(meta.name),
    });
  }

  // --- View ---
  out.push({
    id: "view.font.larger",
    label: "Font: larger",
    group: "view",
    hint: "⌘+",
    run: () => hooks.bumpFont(+1),
  });
  out.push({
    id: "view.font.smaller",
    label: "Font: smaller",
    group: "view",
    hint: "⌘-",
    run: () => hooks.bumpFont(-1),
  });
  out.push({
    id: "view.font.reset",
    label: `Font: reset (${config.font.size}px)`,
    group: "view",
    hint: "⌘0",
    run: () => hooks.resetFont(),
  });

  // --- Settings ---
  out.push({
    id: "settings.open",
    label: "Settings…",
    group: "settings",
    hint: "⌘,",
    run: () => hooks.openSettings(),
  });
  // Per-section deep links. spec §14 lists "設定項目検索" — a single
  // "Settings…" entry doesn't satisfy that, so we surface one row per
  // section. Each opens the panel scrolled to its section.
  const sections: { id: SettingsSection; label: string }[] = [
    { id: "font", label: "Settings: Font" },
    { id: "send", label: "Settings: Send options" },
    { id: "scrollback", label: "Settings: Scrollback" },
    { id: "session", label: "Settings: Session (autosave / restore)" },
    { id: "default-pane", label: "Settings: Default pane" },
    { id: "pane-presets", label: "Settings: Pane presets" },
    { id: "theme", label: "Settings: Theme" },
    { id: "keybind", label: "Settings: Keybindings" },
    { id: "logging", label: "Settings: Logging" },
    { id: "import-export", label: "Settings: Import / Export" },
  ];
  for (const s of sections) {
    out.push({
      id: `settings.open.${s.id}`,
      label: s.label,
      group: "settings",
      run: () => hooks.openSettings(s.id),
    });
  }

  // --- Pipe rules ---
  out.push({
    id: "pipe.open",
    label: "Pipe rules…",
    group: "pipe",
    run: () => hooks.openPipeRules(),
  });
  for (const r of pipeRules) {
    const src = store.panes[r.source]?.label ?? r.source;
    const dst = store.panes[r.target]?.label ?? r.target;
    out.push({
      id: `pipe.toggle.${r.id}`,
      label: `Toggle rule: ${src} → ${dst}`,
      group: "pipe",
      hint: r.enabled ? "on" : "off",
      run: () => hooks.togglePipeRule(r.id, !r.enabled),
    });
  }

  // --- Logs ---
  for (const id of store.paneOrder) {
    const spec = store.panes[id];
    if (!spec) continue;
    out.push({
      id: `logs.open.${id}`,
      label: `Logs: ${spec.label}…`,
      group: "logs",
      run: () => hooks.openLogs(id),
    });
  }

  return out;
}
