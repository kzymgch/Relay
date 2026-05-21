// Match a KeyboardEvent against a ParsedCombo.
//
// Modifier comparison is strict: a combo without `shift` must not match an
// event that has shift pressed (otherwise `cmd+1` would swallow the
// `cmd+shift+1` send-to-pane shortcut). `event.code` is matched verbatim so
// layout differences don't bite — see the rationale in combo.ts.
//
// One concession: for the few keys whose shifted form is its own glyph on
// US keyboards (Equal → `+`, Minus → `_`), `cmd+=` is also fired by
// `cmd++` (= shift+Equal). The ergonomic value of accepting either is high
// and the only thing it costs is the ability to bind `cmd+shift+=` to a
// distinct action — which nothing in the registry does.

import type { ParsedCombo } from "./combo";

const SHIFT_FLEXIBLE_CODES = new Set(["Equal", "Minus"]);

export function matches(event: KeyboardEvent, combo: ParsedCombo): boolean {
  if (event.metaKey !== combo.meta) return false;
  if (event.ctrlKey !== combo.ctrl) return false;
  if (event.altKey !== combo.alt) return false;
  if (event.code !== combo.code) return false;
  if (event.shiftKey === combo.shift) return true;
  // Allow shift drift only for the keys called out above and only when the
  // combo did not explicitly opt into Shift.
  if (!combo.shift && event.shiftKey && SHIFT_FLEXIBLE_CODES.has(combo.code)) {
    return true;
  }
  return false;
}
