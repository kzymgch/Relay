// Resolve `config.keybind` overrides against `KEYBIND_ACTIONS` defaults.
//
// Output is `Map<actionId, ParsedCombo | null>` where `null` means the user
// explicitly cleared the binding (the dispatcher must not fall back to the
// default in that case). Missing keys inherit the default combo.

import { parseCombo, type ParsedCombo } from "./combo";
import { KEYBIND_ACTIONS, type KeybindActionDef } from "./actions";

export type ResolvedKeybinds = Map<string, ParsedCombo | null>;

export function resolveKeybinds(
  userMap: Record<string, string> | undefined,
  actions: readonly KeybindActionDef[] = KEYBIND_ACTIONS
): ResolvedKeybinds {
  const out: ResolvedKeybinds = new Map();
  for (const a of actions) {
    const override = userMap?.[a.id];
    if (typeof override === "string") {
      const trimmed = override.trim();
      if (trimmed === "") {
        // Explicitly cleared by the user — record `null` so dispatcher skips.
        out.set(a.id, null);
        continue;
      }
      const parsed = parseCombo(trimmed);
      if (parsed) {
        out.set(a.id, parsed);
        continue;
      }
      // Malformed override falls back to default rather than swallowing the
      // action entirely. Combined with the conflict detector's report, the
      // settings UI will surface the bad value to the user.
    }
    const def = parseCombo(a.defaultCombo);
    out.set(a.id, def);
  }
  return out;
}
