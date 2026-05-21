import { describe, expect, it } from "vitest";

import { detectConflicts } from "../../src/lib/keybind/conflicts";
import { resolveKeybinds } from "../../src/lib/keybind/resolve";

describe("keybind/conflicts", () => {
  it("defaults alone are conflict-free", () => {
    const resolved = resolveKeybinds({});
    expect(detectConflicts(resolved)).toEqual([]);
  });

  it("reports two actions bound to the same combo", () => {
    const resolved = resolveKeybinds({
      "palette.open": "cmd+p",
      "settings.open": "cmd+p",
    });
    const conflicts = detectConflicts(resolved);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.combo).toBe("cmd+p");
    expect(conflicts[0]!.actionIds.sort()).toEqual(["palette.open", "settings.open"]);
  });

  it("explicitly-cleared overrides are not counted", () => {
    const resolved = resolveKeybinds({
      "palette.open": "",
      "settings.open": "cmd+p",
    });
    // palette.open is null (cleared) — settings.open holding cmd+p alone is fine.
    expect(detectConflicts(resolved)).toEqual([]);
  });
});
