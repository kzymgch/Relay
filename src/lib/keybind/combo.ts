// Combo string ↔ structured ParsedCombo.
//
// User-facing combos are mac-flavoured (`cmd+shift+1`, `cmd+,`, `cmd+=`).
// The dispatcher matches against `event.code` rather than `event.key`
// because `event.key` is layout-dependent — on a US keyboard `cmd+shift+1`
// arrives with `event.key === "!"`, which would silently break the binding
// if we parsed by character.

export interface ParsedCombo {
  meta: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  /** KeyboardEvent.code value, e.g. `"Digit1"`, `"KeyP"`, `"Equal"`. */
  code: string;
}

/** Token-to-code map for non-letter / non-digit keys. Lowercase aliases
 *  only — the parser normalises before lookup. F-keys, digit-bearing
 *  Numpad codes, and other regular cases go through regex branches. */
const TOKEN_TO_CODE: Record<string, string> = {
  "=": "Equal",
  "+": "Equal", // `cmd+=` is sometimes written as `cmd++`; treat both the same.
  "-": "Minus",
  _: "Minus",
  ",": "Comma",
  ".": "Period",
  "/": "Slash",
  ";": "Semicolon",
  "'": "Quote",
  "`": "Backquote",
  "[": "BracketLeft",
  "]": "BracketRight",
  "\\": "Backslash",
  enter: "Enter",
  return: "Enter",
  escape: "Escape",
  esc: "Escape",
  space: "Space",
  tab: "Tab",
  backspace: "Backspace",
  delete: "Delete",
  del: "Delete",
  insert: "Insert",
  ins: "Insert",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pgup: "PageUp",
  pagedown: "PageDown",
  pgdn: "PageDown",
  pgdown: "PageDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  up: "ArrowUp",
  down: "ArrowDown",
  arrowleft: "ArrowLeft",
  arrowright: "ArrowRight",
  arrowup: "ArrowUp",
  arrowdown: "ArrowDown",
  contextmenu: "ContextMenu",
  menu: "ContextMenu",
  capslock: "CapsLock",
  numlock: "NumLock",
  scrolllock: "ScrollLock",
  printscreen: "PrintScreen",
  pause: "Pause",
  numpadenter: "NumpadEnter",
  numpadadd: "NumpadAdd",
  numpadsubtract: "NumpadSubtract",
  numpadmultiply: "NumpadMultiply",
  numpaddivide: "NumpadDivide",
  numpaddecimal: "NumpadDecimal",
  numpadcomma: "NumpadComma",
  numpadequal: "NumpadEqual",
};

const MODIFIER_ALIASES = new Set([
  "cmd",
  "meta",
  "ctrl",
  "control",
  "alt",
  "opt",
  "option",
  "shift",
]);

/**
 * Parse a combo string. Returns `null` for anything that doesn't yield
 * exactly one non-modifier key. The parser is intentionally forgiving:
 * casing is ignored, whitespace is trimmed, and `+`-separated tokens may
 * include the historic mac-friendly aliases (`opt` → `alt`, `meta` → `cmd`).
 */
export function parseCombo(input: string): ParsedCombo | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;

  let meta = false;
  let ctrl = false;
  let alt = false;
  let shift = false;
  let code: string | undefined;

  // Tokenise on `+` but keep a literal trailing `+` as the key (so users can
  // bind `cmd++` and get `Equal`). `cmd+=` already handles the common case.
  const tokens = trimmed.split("+");
  // Handle the trailing-`+` case: `cmd++` splits to `["cmd", "", ""]`.
  // We collapse two empties into a literal `+` token.
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === "" && i + 1 < tokens.length && tokens[i + 1] === "") {
      tokens.splice(i, 2, "+");
    }
  }

  for (const raw of tokens) {
    const trimmed = raw.trim();
    if (trimmed === "") continue;
    const lower = trimmed.toLowerCase();
    if (MODIFIER_ALIASES.has(lower)) {
      switch (lower) {
        case "cmd":
        case "meta":
          meta = true;
          break;
        case "ctrl":
        case "control":
          ctrl = true;
          break;
        case "alt":
        case "opt":
        case "option":
          alt = true;
          break;
        case "shift":
          shift = true;
          break;
      }
      continue;
    }
    if (code !== undefined) return null; // more than one non-modifier key
    // Pass the original-case token so the verbatim-PascalCase fallback in
    // `tokenToCode` can round-trip codes we don't have a friendly alias
    // for (e.g. `MediaPlayPause`).
    code = tokenToCode(trimmed);
    if (code === undefined) return null;
  }

  if (code === undefined) return null;
  return { meta, ctrl, alt, shift, code };
}

function tokenToCode(rawToken: string): string | undefined {
  const lower = rawToken.toLowerCase();
  if (lower.length === 1) {
    if (/^[a-z]$/.test(lower)) return `Key${lower.toUpperCase()}`;
    if (/^[0-9]$/.test(lower)) return `Digit${lower}`;
    if (lower in TOKEN_TO_CODE) return TOKEN_TO_CODE[lower];
    return undefined;
  }
  if (lower in TOKEN_TO_CODE) return TOKEN_TO_CODE[lower];
  // F1..F24 — KeyboardEvent.code uses uppercase `F<n>`.
  const fKey = /^f([1-9]|1[0-9]|2[0-4])$/.exec(lower);
  if (fKey) return `F${fKey[1]}`;
  // Numpad0..9 — `Numpad${n}` follows the DOM convention.
  const numpadDigit = /^numpad([0-9])$/.exec(lower);
  if (numpadDigit) return `Numpad${numpadDigit[1]}`;
  // Verbatim fallback: accept any PascalCase event.code identifier. This
  // lets `formatCombo` emit the original code for keys we don't yet
  // alias (e.g. `MediaPlayPause`, `AudioVolumeUp`) and still parse them
  // back into the same identifier. The PascalCase shape requirement
  // avoids silently accepting arbitrary user typos as valid combos.
  if (/^[A-Z][A-Za-z0-9]*$/.test(rawToken)) return rawToken;
  return undefined;
}

/**
 * Render `combo` as a canonical, lowercase, `+`-separated string. Useful for
 * settings UI display and for the conflict-detection equality test.
 */
export function formatCombo(combo: ParsedCombo): string {
  const parts: string[] = [];
  if (combo.meta) parts.push("cmd");
  if (combo.ctrl) parts.push("ctrl");
  if (combo.alt) parts.push("alt");
  if (combo.shift) parts.push("shift");
  parts.push(codeToToken(combo.code));
  return parts.join("+");
}

const CODE_TO_TOKEN: Record<string, string> = {
  Equal: "=",
  Minus: "-",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Semicolon: ";",
  Quote: "'",
  Backquote: "`",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Enter: "enter",
  Escape: "escape",
  Space: "space",
  Tab: "tab",
  Backspace: "backspace",
  Delete: "delete",
  Insert: "insert",
  Home: "home",
  End: "end",
  PageUp: "pageup",
  PageDown: "pagedown",
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
  ContextMenu: "contextmenu",
  CapsLock: "capslock",
  NumLock: "numlock",
  ScrollLock: "scrolllock",
  PrintScreen: "printscreen",
  Pause: "pause",
  NumpadEnter: "numpadenter",
  NumpadAdd: "numpadadd",
  NumpadSubtract: "numpadsubtract",
  NumpadMultiply: "numpadmultiply",
  NumpadDivide: "numpaddivide",
  NumpadDecimal: "numpaddecimal",
  NumpadComma: "numpadcomma",
  NumpadEqual: "numpadequal",
};

function codeToToken(code: string): string {
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit) return digit[1]!;
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1]!.toLowerCase();
  const fKey = /^F([1-9]|1[0-9]|2[0-4])$/.exec(code);
  if (fKey) return `f${fKey[1]}`;
  const numpadDigit = /^Numpad([0-9])$/.exec(code);
  if (numpadDigit) return `numpad${numpadDigit[1]}`;
  if (code in CODE_TO_TOKEN) return CODE_TO_TOKEN[code];
  // Verbatim PascalCase fallback so any DOM event.code round-trips even
  // when we don't have an explicit alias. parseCombo's last-resort branch
  // accepts the same identifier back.
  return code;
}

/**
 * Compose a ParsedCombo from a KeyboardEvent — used by the settings Record
 * button. Returns `null` when only modifiers are held (so a lone Cmd press
 * doesn't get committed as a half-formed combo).
 */
export function comboFromEvent(event: KeyboardEvent): ParsedCombo | null {
  if (isModifierCode(event.code)) return null;
  return {
    meta: event.metaKey,
    ctrl: event.ctrlKey,
    alt: event.altKey,
    shift: event.shiftKey,
    code: event.code,
  };
}

function isModifierCode(code: string): boolean {
  return (
    code === "MetaLeft" ||
    code === "MetaRight" ||
    code === "ControlLeft" ||
    code === "ControlRight" ||
    code === "AltLeft" ||
    code === "AltRight" ||
    code === "ShiftLeft" ||
    code === "ShiftRight"
  );
}
