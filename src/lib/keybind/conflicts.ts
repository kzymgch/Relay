// Conflict detection across resolved keybinds.
//
// Two actions sharing the same `ParsedCombo` (same modifiers + same key code)
// are a conflict. `null` entries (explicitly-cleared user overrides) are
// skipped because they don't fire at all.

import { formatCombo, type ParsedCombo } from "./combo";
import type { ResolvedKeybinds } from "./resolve";

export interface KeybindConflict {
  /** Canonical lowercase combo string, e.g. `cmd+shift+1`. */
  combo: string;
  /** Action ids sharing this combo, in iteration order from `resolved`. */
  actionIds: string[];
}

export function detectConflicts(resolved: ResolvedKeybinds): KeybindConflict[] {
  const groups = new Map<string, string[]>();
  for (const [actionId, combo] of resolved.entries()) {
    if (combo === null) continue;
    const key = canonicalKey(combo);
    const existing = groups.get(key);
    if (existing) {
      existing.push(actionId);
    } else {
      groups.set(key, [actionId]);
    }
  }
  const out: KeybindConflict[] = [];
  for (const [key, actionIds] of groups.entries()) {
    if (actionIds.length > 1) {
      out.push({ combo: key, actionIds });
    }
  }
  return out;
}

function canonicalKey(combo: ParsedCombo): string {
  return formatCombo(combo);
}
