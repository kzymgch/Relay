// KeyboardEvent → action.id dispatcher.
//
// Pure function so AppRoot's keydown listener can call `dispatchKey(event,
// resolved)` and route the returned action.id to its handler map. First
// match in `KEYBIND_ACTIONS` declaration order wins, preserving today's
// switch-statement precedence when no overrides exist.

import { matches } from "./matches";
import { KEYBIND_ACTIONS } from "./actions";
import type { ResolvedKeybinds } from "./resolve";

export function dispatchKey(event: KeyboardEvent, resolved: ResolvedKeybinds): string | undefined {
  for (const def of KEYBIND_ACTIONS) {
    const combo = resolved.get(def.id);
    if (!combo) continue;
    if (matches(event, combo)) return def.id;
  }
  return undefined;
}

/**
 * Should the dispatcher honour `event` despite it landing on an editable
 * element (an `<input>`, `<textarea>`, `<select>`, or contentEditable)?
 *
 * The rule: any cmd/ctrl/alt modifier opts the keystroke out of typing, so
 * it always fires. Without one of those modifiers, only "non-typeable"
 * codes (F-keys, arrow keys, Home / End / Insert, Numpad navigation, …)
 * fire — bare letters and digits stay with the focused input so the user
 * doesn't get their text input silently hijacked by an aggressive custom
 * binding.
 *
 * Lives here rather than inline in AppRoot so the page handler stays
 * focused on routing and the rules get unit-tested.
 */
export function shouldHandleInEditable(event: KeyboardEvent): boolean {
  // Shortcut keys with an explicit modifier always fire.
  if (event.metaKey || event.ctrlKey || event.altKey) return true;
  // Non-printable keys (F-keys, navigation, numpad, escape, etc.) always
  // fire — those don't conflict with normal typing.
  if (!isPrintableCode(event.code)) return true;
  // Modifier-less printable codes only fire when the focus is NOT in an
  // editable element. Inside a text input we'd be stealing the user's
  // keystroke; outside it (toolbar, pane chrome, body) we wouldn't.
  return !isEditableTarget(event.target);
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (target.isContentEditable) return true;
  // jsdom doesn't always reflect `element.contentEditable = "true"` into
  // `isContentEditable`; fall back to the attribute so the rule still
  // applies in component tests.
  const attr = target.getAttribute("contenteditable");
  return attr === "" || attr === "true" || attr === "plaintext-only";
}

/** Codes whose default action is to produce a printable character on a
 *  standard US layout. Listed explicitly so the answer doesn't drift if
 *  the DOM adds new codes (e.g. media keys we'd never want to suppress). */
function isPrintableCode(code: string): boolean {
  return (
    /^Key[A-Z]$/.test(code) ||
    /^Digit[0-9]$/.test(code) ||
    code === "Space" ||
    code === "Minus" ||
    code === "Equal" ||
    code === "Comma" ||
    code === "Period" ||
    code === "Slash" ||
    code === "Semicolon" ||
    code === "Quote" ||
    code === "Backquote" ||
    code === "Backslash" ||
    code === "BracketLeft" ||
    code === "BracketRight" ||
    code === "IntlBackslash" ||
    code === "IntlRo" ||
    code === "IntlYen"
  );
}
