// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import { parseCombo } from "../../src/lib/keybind/combo";
import { matches } from "../../src/lib/keybind/matches";

describe("keybind/matches", () => {
  it("matches event.code with stable modifier comparison", () => {
    const combo = parseCombo("cmd+shift+1")!;
    // On a US layout cmd+shift+1 arrives with event.key === "!" — match by
    // event.code so layout/Shift state don't drop the binding.
    const event = new KeyboardEvent("keydown", {
      code: "Digit1",
      key: "!",
      metaKey: true,
      shiftKey: true,
    });
    expect(matches(event, combo)).toBe(true);
  });

  it("rejects superset modifier state (cmd+1 must not match cmd+shift+1)", () => {
    const combo = parseCombo("cmd+1")!;
    const event = new KeyboardEvent("keydown", {
      code: "Digit1",
      metaKey: true,
      shiftKey: true,
    });
    expect(matches(event, combo)).toBe(false);
  });

  it("rejects mismatched code", () => {
    const combo = parseCombo("cmd+p")!;
    const event = new KeyboardEvent("keydown", { code: "KeyQ", metaKey: true });
    expect(matches(event, combo)).toBe(false);
  });
});
