// Canonical action registry for keyboard shortcuts.
//
// Every shortcut that used to live as a hardcoded switch arm in
// `AppRoot.handleKeydown` is now a row in `KEYBIND_ACTIONS`. The settings
// UI iterates this list to render one row per action; the dispatcher
// resolves user overrides against the default combo declared here.
//
// Order matters: when two actions resolve to the same combo (a user-induced
// conflict), the dispatcher fires the first one in this list, which keeps
// today's switch-statement precedence (font > digit > shifted digit > …)
// intact for defaults-only configurations.

export type KeybindActionId =
  | "view.font.larger"
  | "view.font.smaller"
  | "view.font.reset"
  | `pane.focus.${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`
  | `send.to.${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`
  | "palette.open"
  | "settings.open"
  | "pane.clear"
  | "pane.restart"
  | "pane.search"
  | "pane.open-url";

export interface KeybindActionDef {
  id: KeybindActionId;
  label: string;
  defaultCombo: string;
}

function focusActions(): KeybindActionDef[] {
  const out: KeybindActionDef[] = [];
  for (let i = 1; i <= 9; i++) {
    out.push({
      id: `pane.focus.${i}` as KeybindActionId,
      label: `Focus pane ${i}`,
      defaultCombo: `cmd+${i}`,
    });
  }
  return out;
}

function sendActions(): KeybindActionDef[] {
  const out: KeybindActionDef[] = [];
  for (let i = 1; i <= 9; i++) {
    out.push({
      id: `send.to.${i}` as KeybindActionId,
      label: `Send selection to pane ${i}`,
      defaultCombo: `cmd+shift+${i}`,
    });
  }
  return out;
}

/** Canonical, ordered registry. Order is the dispatcher's conflict
 *  tie-break, so keep font > focus > send > rest to preserve today's
 *  switch-statement semantics. */
export const KEYBIND_ACTIONS: readonly KeybindActionDef[] = [
  { id: "view.font.larger", label: "Font: larger", defaultCombo: "cmd+=" },
  { id: "view.font.smaller", label: "Font: smaller", defaultCombo: "cmd+-" },
  { id: "view.font.reset", label: "Font: reset", defaultCombo: "cmd+0" },
  ...focusActions(),
  ...sendActions(),
  { id: "palette.open", label: "Open command palette", defaultCombo: "cmd+p" },
  { id: "settings.open", label: "Open settings", defaultCombo: "cmd+," },
  { id: "pane.clear", label: "Clear focused pane (Cmd+K)", defaultCombo: "cmd+k" },
  { id: "pane.restart", label: "Restart focused pane (Cmd+R)", defaultCombo: "cmd+r" },
  { id: "pane.search", label: "Search in focused pane (Cmd+F)", defaultCombo: "cmd+f" },
  {
    id: "pane.open-url",
    label: "Open last URL in browser (Cmd+Enter)",
    defaultCombo: "cmd+enter",
  },
];

/** Quick lookup by id. */
export const KEYBIND_ACTION_BY_ID: Record<string, KeybindActionDef> = Object.fromEntries(
  KEYBIND_ACTIONS.map((a) => [a.id, a])
);

/** Default user-map (action.id → combo). Useful as the form's reset target. */
export function defaultKeybindMap(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of KEYBIND_ACTIONS) {
    out[a.id] = a.defaultCombo;
  }
  return out;
}
