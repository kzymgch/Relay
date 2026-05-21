import { describe, expect, it } from "vitest";

import { BUILTIN_THEMES, FALLBACK_THEME } from "../../src/lib/theme/presets";
import { resolveTheme } from "../../src/lib/theme/resolve";

describe("theme/resolve", () => {
  it("returns the matching builtin verbatim", () => {
    const resolved = resolveTheme({ preset: "solarized-dark" });
    expect(resolved.id).toBe("solarized-dark");
    expect(resolved.xterm.background).toBe(BUILTIN_THEMES["solarized-dark"].xterm.background);
    expect(resolved.chrome.appBg).toBe(BUILTIN_THEMES["solarized-dark"].chrome.appBg);
  });

  it("unknown preset falls back to the dark default", () => {
    const resolved = resolveTheme({ preset: "octopus" });
    expect(resolved.id).toBe(FALLBACK_THEME.id);
    expect(resolved.xterm.background).toBe(FALLBACK_THEME.xterm.background);
  });

  it("custom preset merges xterm + chrome overrides over the dark fallback", () => {
    const resolved = resolveTheme({
      preset: "custom",
      custom: {
        xterm: { background: "#112233", foreground: "#ddeeff" },
        chrome: { appBg: "#001122" },
      },
    });
    expect(resolved.id).toBe("custom");
    expect(resolved.xterm.background).toBe("#112233");
    expect(resolved.xterm.foreground).toBe("#ddeeff");
    expect(resolved.chrome.appBg).toBe("#001122");
    // Untouched slots inherit from FALLBACK_THEME (dark).
    expect(resolved.chrome.paneBg).toBe(FALLBACK_THEME.chrome.paneBg);
  });

  it("custom preset with no payload falls back to dark slots", () => {
    const resolved = resolveTheme({ preset: "custom" });
    expect(resolved.id).toBe("custom");
    expect(resolved.xterm.background).toBe(FALLBACK_THEME.xterm.background);
  });

  it("returned palettes are independent of the BUILTIN registry", () => {
    const resolved = resolveTheme({ preset: "dark" });
    resolved.xterm.background = "#ff00ff";
    expect(BUILTIN_THEMES.dark.xterm.background).not.toBe("#ff00ff");
  });
});
