/**
 * @vitest-environment jsdom
 */

import { describe, expect, it } from "vitest";

import { applyChromePalette, cssVarName } from "../../src/lib/theme/chrome";
import { BUILTIN_THEMES } from "../../src/lib/theme/presets";

describe("theme/chrome", () => {
  it("cssVarName produces kebab-cased `--relay-*` strings", () => {
    expect(cssVarName("appBg")).toBe("--relay-app-bg");
    expect(cssVarName("paneBorderFocused")).toBe("--relay-pane-border-focused");
    expect(cssVarName("statusRunning")).toBe("--relay-status-running");
  });

  it("applyChromePalette writes every slot onto the target element", () => {
    const host = document.createElement("div");
    applyChromePalette(BUILTIN_THEMES.light.chrome, host);
    expect(host.style.getPropertyValue("--relay-app-bg")).toBe("#f5f5f5");
    expect(host.style.getPropertyValue("--relay-modal-bg")).toBe("#ffffff");
  });
});
