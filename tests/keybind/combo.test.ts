// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import { comboFromEvent, formatCombo, parseCombo } from "../../src/lib/keybind/combo";

describe("keybind/combo: parseCombo", () => {
  it("parses common defaults", () => {
    expect(parseCombo("cmd+p")).toEqual({
      meta: true,
      ctrl: false,
      alt: false,
      shift: false,
      code: "KeyP",
    });
    expect(parseCombo("cmd+shift+1")).toEqual({
      meta: true,
      ctrl: false,
      alt: false,
      shift: true,
      code: "Digit1",
    });
    expect(parseCombo("cmd+,")).toEqual({
      meta: true,
      ctrl: false,
      alt: false,
      shift: false,
      code: "Comma",
    });
    expect(parseCombo("cmd+=")).toEqual({
      meta: true,
      ctrl: false,
      alt: false,
      shift: false,
      code: "Equal",
    });
    expect(parseCombo("cmd+-")).toEqual({
      meta: true,
      ctrl: false,
      alt: false,
      shift: false,
      code: "Minus",
    });
  });

  it("accepts modifier aliases", () => {
    expect(parseCombo("META+P")?.meta).toBe(true);
    expect(parseCombo("opt+k")?.alt).toBe(true);
    expect(parseCombo("control+space")?.ctrl).toBe(true);
  });

  it("returns null for malformed combos", () => {
    expect(parseCombo("")).toBeNull();
    expect(parseCombo("cmd")).toBeNull();
    expect(parseCombo("cmd+shift")).toBeNull();
    expect(parseCombo("cmd+p+q")).toBeNull(); // two non-modifier keys
  });

  it("round-trips through formatCombo", () => {
    const combos = [
      "cmd+p",
      "cmd+shift+1",
      "cmd+,",
      "cmd+=",
      "cmd+-",
      "cmd+0",
      "cmd+k",
      "f8",
      "ctrl+home",
      "alt+end",
      "cmd+pageup",
      "cmd+pagedown",
      "cmd+insert",
      "cmd+delete",
      "cmd+numpadenter",
      "cmd+numpad0",
      "cmd+contextmenu",
    ];
    for (const c of combos) {
      const parsed = parseCombo(c);
      expect(parsed, c).not.toBeNull();
      expect(formatCombo(parsed!)).toBe(c);
    }
  });

  it("parses every event.code the recorder could emit and round-trips it", () => {
    // Regression: comboFromEvent stamps the raw event.code, but parseCombo
    // used to only recognise a fixed alias list. Anything not in the list
    // (Home, PageUp, NumpadEnter, …) ended up as a valid string that
    // resolveKeybinds silently swapped back to the default.
    const codes = [
      "KeyA",
      "Digit2",
      "F8",
      "Home",
      "End",
      "PageUp",
      "PageDown",
      "Insert",
      "Delete",
      "Numpad0",
      "NumpadEnter",
      "NumpadDecimal",
      "ContextMenu",
      "MediaPlayPause", // never aliased — verbatim fallback must round-trip it
    ];
    for (const code of codes) {
      const event = new KeyboardEvent("keydown", { code });
      const fromEvent = comboFromEvent(event);
      expect(fromEvent, code).not.toBeNull();
      const formatted = formatCombo(fromEvent!);
      const reparsed = parseCombo(formatted);
      expect(reparsed, `${code} → ${formatted}`).not.toBeNull();
      expect(reparsed!.code).toBe(code);
    }
  });

  it("formatCombo emits modifiers in cmd/ctrl/alt/shift order", () => {
    expect(formatCombo({ meta: true, ctrl: true, alt: true, shift: true, code: "KeyA" })).toBe(
      "cmd+ctrl+alt+shift+a"
    );
  });
});

describe("keybind/combo: comboFromEvent", () => {
  it("captures the modifier state", () => {
    const event = new KeyboardEvent("keydown", {
      code: "Digit2",
      metaKey: true,
      shiftKey: true,
    });
    expect(comboFromEvent(event)).toEqual({
      meta: true,
      ctrl: false,
      alt: false,
      shift: true,
      code: "Digit2",
    });
  });

  it("ignores lone modifier presses", () => {
    const event = new KeyboardEvent("keydown", { code: "MetaLeft", metaKey: true });
    expect(comboFromEvent(event)).toBeNull();
  });
});
