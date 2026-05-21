// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";

import { defaultConfig, loadConfig, saveConfig, type RelayConfig } from "../src/lib/config";

interface Call {
  cmd: string;
  args: Record<string, unknown>;
}

let calls: Call[] = [];

function captureWith<T>(responder?: (cmd: string, args: Record<string, unknown>) => T) {
  mockIPC((cmd, args) => {
    const normalized = (args ?? {}) as Record<string, unknown>;
    calls.push({ cmd, args: normalized });
    return responder?.(cmd, normalized);
  });
}

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  clearMocks();
});

describe("config bridge", () => {
  it("loadConfig returns the Rust payload when present", async () => {
    const fixture: RelayConfig = {
      ...defaultConfig(),
      font: { family: "Iosevka", size: 17 },
    };
    captureWith(() => fixture);
    const cfg = await loadConfig();
    expect(cfg.font.size).toBe(17);
    expect(cfg.font.family).toBe("Iosevka");
    // Other fields fall back to defaults that mirror Rust's RelayConfig::default.
    expect(cfg.send).toEqual(defaultConfig().send);
    expect(calls[0]).toEqual({ cmd: "config_load", args: {} });
  });

  it("loadConfig falls back to in-memory defaults when the bridge returns undefined", async () => {
    captureWith(() => undefined);
    const cfg = await loadConfig();
    expect(cfg).toEqual(defaultConfig());
  });

  it("saveConfig forwards the camelCase shape", async () => {
    captureWith();
    const cfg = defaultConfig();
    cfg.session.autosaveOnExit = false;
    await saveConfig(cfg);
    expect(calls[0]).toEqual({ cmd: "config_save", args: { config: cfg } });
  });
});
