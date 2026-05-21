// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import { dispatchKey, shouldHandleInEditable } from "../../src/lib/keybind/dispatch";
import { resolveKeybinds } from "../../src/lib/keybind/resolve";

function key(opts: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent("keydown", opts);
}

function eventOn(target: HTMLElement, opts: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent("keydown", opts);
  Object.defineProperty(event, "target", { value: target });
  return event;
}

describe("keybind/dispatch", () => {
  it("routes default cmd+p to palette.open", () => {
    const resolved = resolveKeybinds({});
    expect(dispatchKey(key({ code: "KeyP", metaKey: true }), resolved)).toBe("palette.open");
  });

  it("routes default cmd+shift+1 to send.to.1", () => {
    const resolved = resolveKeybinds({});
    expect(dispatchKey(key({ code: "Digit1", metaKey: true, shiftKey: true }), resolved)).toBe(
      "send.to.1"
    );
  });

  it("honours a user override that remaps palette.open", () => {
    const resolved = resolveKeybinds({ "palette.open": "cmd+shift+p" });
    // Original combo no longer fires
    expect(dispatchKey(key({ code: "KeyP", metaKey: true }), resolved)).toBeUndefined();
    // New combo does
    expect(dispatchKey(key({ code: "KeyP", metaKey: true, shiftKey: true }), resolved)).toBe(
      "palette.open"
    );
  });

  it("first declared action wins on conflict", () => {
    // pane.focus.1 (cmd+1) is declared *before* a hypothetical override that
    // remaps palette.open to cmd+1. The defaults list determines precedence.
    const resolved = resolveKeybinds({ "palette.open": "cmd+1" });
    expect(dispatchKey(key({ code: "Digit1", metaKey: true }), resolved)).toBe("pane.focus.1");
  });

  it("returns undefined for unrelated events", () => {
    const resolved = resolveKeybinds({});
    expect(dispatchKey(key({ code: "KeyA" }), resolved)).toBeUndefined();
  });

  it("fires a non-Cmd custom binding (ctrl+k or bare F-key)", () => {
    // Regression: handleKeydown used to short-circuit on !event.metaKey,
    // which silently dropped any user-customised non-Cmd binding even
    // though the settings UI accepted it.
    const resolved = resolveKeybinds({
      "pane.clear": "ctrl+k",
      "view.font.larger": "f8",
    });
    expect(dispatchKey(key({ code: "KeyK", ctrlKey: true }), resolved)).toBe("pane.clear");
    expect(dispatchKey(key({ code: "F8" }), resolved)).toBe("view.font.larger");
  });
});

describe("keybind/dispatch: shouldHandleInEditable", () => {
  it("modifier-based combos always fire, even inside a textarea", () => {
    const ta = document.createElement("textarea");
    document.body.appendChild(ta);
    expect(shouldHandleInEditable(eventOn(ta, { code: "KeyK", metaKey: true }))).toBe(true);
    expect(shouldHandleInEditable(eventOn(ta, { code: "KeyR", ctrlKey: true }))).toBe(true);
    document.body.removeChild(ta);
  });

  it("non-printable codes (F-keys, arrows, Home) fire even inside a textarea", () => {
    const ta = document.createElement("textarea");
    document.body.appendChild(ta);
    expect(shouldHandleInEditable(eventOn(ta, { code: "F8" }))).toBe(true);
    expect(shouldHandleInEditable(eventOn(ta, { code: "Home" }))).toBe(true);
    expect(shouldHandleInEditable(eventOn(ta, { code: "ArrowLeft" }))).toBe(true);
    document.body.removeChild(ta);
  });

  it("bare printable codes are suppressed inside textarea / input / contentEditable", () => {
    const ta = document.createElement("textarea");
    const input = document.createElement("input");
    const div = document.createElement("div");
    // Use setAttribute directly — jsdom doesn't reliably reflect the
    // `.contentEditable = "true"` JS setter into the attribute, and the
    // production code falls back to the attribute when isContentEditable
    // is false.
    div.setAttribute("contenteditable", "true");
    document.body.append(ta, input, div);
    expect(shouldHandleInEditable(eventOn(ta, { code: "KeyR" }))).toBe(false);
    expect(shouldHandleInEditable(eventOn(input, { code: "Digit1" }))).toBe(false);
    expect(shouldHandleInEditable(eventOn(div, { code: "KeyA", shiftKey: true }))).toBe(false);
    document.body.removeChild(ta);
    document.body.removeChild(input);
    document.body.removeChild(div);
  });

  it("bare printable codes fire when focus is outside an editable element", () => {
    // Buttons, the body, the toolbar, etc. are fair game for bare-letter
    // bindings — the user opted into the keystroke.
    const btn = document.createElement("button");
    document.body.appendChild(btn);
    expect(shouldHandleInEditable(eventOn(btn, { code: "KeyR" }))).toBe(true);
    document.body.removeChild(btn);
  });
});
