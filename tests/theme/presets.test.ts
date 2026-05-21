import { describe, expect, it } from "vitest";

import { BUILTIN_THEMES, BUILTIN_THEME_IDS, isBuiltinThemeId } from "../../src/lib/theme/presets";
import { CHROME_SLOTS } from "../../src/lib/theme/chrome";

describe("theme/presets", () => {
  it("exports every id listed in BUILTIN_THEME_IDS", () => {
    for (const id of BUILTIN_THEME_IDS) {
      expect(BUILTIN_THEMES[id]).toBeDefined();
      expect(BUILTIN_THEMES[id].id).toBe(id);
    }
  });

  it("each builtin defines every chrome slot", () => {
    for (const id of BUILTIN_THEME_IDS) {
      const theme = BUILTIN_THEMES[id];
      for (const slot of CHROME_SLOTS) {
        expect(theme.chrome[slot], `${id} missing chrome.${slot}`).toBeTruthy();
      }
    }
  });

  it("each builtin defines the high-impact xterm slots", () => {
    const required = ["background", "foreground", "cursor"] as const;
    for (const id of BUILTIN_THEME_IDS) {
      const theme = BUILTIN_THEMES[id];
      for (const slot of required) {
        expect(theme.xterm[slot], `${id} missing xterm.${slot}`).toBeTruthy();
      }
    }
  });

  it("isBuiltinThemeId rejects unknown ids", () => {
    expect(isBuiltinThemeId("dark")).toBe(true);
    expect(isBuiltinThemeId("custom")).toBe(false);
    expect(isBuiltinThemeId("octopus")).toBe(false);
  });
});
