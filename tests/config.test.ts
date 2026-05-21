// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";

import { defaultConfig, loadConfig, saveConfig, type RelayConfig } from "../src/lib/config";
import { createConfigStore } from "../src/lib/config.svelte";

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

describe("createConfigStore", () => {
  it("does not leak unvalidated state on save failure", async () => {
    // Simulate Rust rejecting the config (validation, IO). The thrown
    // error must NOT have updated the reactive `current`.
    captureWith((cmd) => {
      if (cmd === "config_save") {
        throw new Error("font.size must be in 8..=32");
      }
      return undefined;
    });
    const store = createConfigStore();
    const original = store.current;
    const broken: RelayConfig = { ...original, font: { ...original.font, size: 999 } };
    await expect(store.set(broken)).rejects.toThrow();
    expect(store.current.font.size).toBe(original.font.size);
  });

  it("commits the reactive copy on save success", async () => {
    captureWith();
    const store = createConfigStore();
    const next: RelayConfig = { ...store.current, font: { ...store.current.font, size: 20 } };
    await store.set(next);
    expect(store.current.font.size).toBe(20);
  });
});
