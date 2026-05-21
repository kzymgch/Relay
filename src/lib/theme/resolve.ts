// Theme resolver: ThemeConfig → { xterm, chrome }.
//
// The config carries one of:
//   - a built-in preset id (`"dark"`, `"solarized-dark"`, …) → return that
//     preset verbatim, ignoring `custom`.
//   - `"custom"` plus a `custom` payload → merge the payload's known slots
//     over the fallback theme so missing fields don't blow up rendering.
// Anything else falls back to the default dark theme. Unknown slot keys in
// `custom` are silently ignored so a future schema bump doesn't crash older
// builds reading a newer config file.

import type { ITheme } from "@xterm/xterm";

import type { ChromePalette } from "./chrome";
import { BUILTIN_THEMES, FALLBACK_THEME, isBuiltinThemeId, type ThemeDef } from "./presets";

export interface ThemeConfigLike {
  preset: string;
  transparent?: boolean;
  custom?: CustomThemeConfig | null;
}

export interface CustomThemeConfig {
  xterm?: Record<string, string>;
  chrome?: Record<string, string>;
}

/** Slot keys understood by the custom-xterm override map. */
const XTERM_SLOTS: readonly (keyof ITheme)[] = [
  "background",
  "foreground",
  "cursor",
  "cursorAccent",
  "selectionBackground",
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
];

const CHROME_SLOTS: readonly (keyof ChromePalette)[] = [
  "appBg",
  "toolbarBg",
  "toolbarBorder",
  "toolbarFg",
  "paneBg",
  "paneBorder",
  "paneBorderFocused",
  "paneHeaderBg",
  "paneHeaderFg",
  "dropHighlight",
  "statusRunning",
  "statusSpawning",
  "statusExited",
  "statusError",
  "modalBackdrop",
  "modalBg",
  "modalFg",
  "paletteBg",
  "paletteHighlight",
  "statusBarBg",
  "statusBarFg",
];

export interface ResolvedTheme {
  id: string;
  xterm: ITheme;
  chrome: ChromePalette;
}

export function resolveTheme(cfg: ThemeConfigLike): ResolvedTheme {
  if (isBuiltinThemeId(cfg.preset)) {
    return toResolved(BUILTIN_THEMES[cfg.preset]);
  }
  if (cfg.preset === "custom") {
    return toResolved(mergeCustom(FALLBACK_THEME, cfg.custom ?? {}));
  }
  return toResolved(FALLBACK_THEME);
}

function toResolved(def: ThemeDef): ResolvedTheme {
  // Defensive copies — callers should not be able to mutate `BUILTIN_THEMES`
  // by writing through the returned palette.
  return {
    id: def.id,
    xterm: { ...def.xterm },
    chrome: { ...def.chrome },
  };
}

function mergeCustom(base: ThemeDef, custom: CustomThemeConfig): ThemeDef {
  const xterm: ITheme = { ...base.xterm };
  if (custom.xterm) {
    for (const slot of XTERM_SLOTS) {
      const value = custom.xterm[slot];
      if (typeof value === "string" && value.length > 0) {
        (xterm as Record<string, string>)[slot] = value;
      }
    }
  }
  const chrome: ChromePalette = { ...base.chrome };
  if (custom.chrome) {
    for (const slot of CHROME_SLOTS) {
      const value = custom.chrome[slot];
      if (typeof value === "string" && value.length > 0) {
        chrome[slot] = value;
      }
    }
  }
  return { id: "custom", label: "Custom", xterm, chrome };
}
