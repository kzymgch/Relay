// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/svelte";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";

vi.mock("../../src/lib/modal.css", () => ({}));
vi.mock("../../src/lib/settings/settings-panel.css", () => ({}));

import SettingsPanel from "../../src/lib/settings/SettingsPanel.svelte";
import { createConfigStore } from "../../src/lib/config.svelte";
import { defaultConfig } from "../../src/lib/config";

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
  cleanup();
});

describe("SettingsPanel", () => {
  it("does not render when open is false", () => {
    captureWith();
    const config = createConfigStore();
    const { container } = render(SettingsPanel, {
      props: { open: false, config, onclose: vi.fn() },
    });
    expect(container.querySelector('[data-testid="settings-panel"]')).toBeNull();
  });

  it("Save writes the edited font size through saveConfig", async () => {
    captureWith();
    const config = createConfigStore();
    const { container } = render(SettingsPanel, {
      props: { open: true, config, onclose: vi.fn() },
    });
    const sizeInput = container.querySelector(
      '[data-testid="settings-font-size"]'
    ) as HTMLInputElement;
    await fireEvent.input(sizeInput, { target: { value: "20" } });
    await fireEvent.click(container.querySelector('[data-testid="settings-save"]') as HTMLElement);

    await vi.waitFor(() => {
      const save = calls.find((c) => c.cmd === "config_save");
      expect(save).toBeDefined();
      expect((save!.args.config as { font: { size: number } }).font.size).toBe(20);
    });
  });

  it("Save reflects autosave toggle", async () => {
    captureWith();
    const config = createConfigStore();
    const { container } = render(SettingsPanel, {
      props: { open: true, config, onclose: vi.fn() },
    });
    const toggle = container.querySelector(
      '[data-testid="settings-session-autosave"]'
    ) as HTMLInputElement;
    expect(toggle.checked).toBe(defaultConfig().session.autosaveOnExit);
    await fireEvent.click(toggle);
    await fireEvent.click(container.querySelector('[data-testid="settings-save"]') as HTMLElement);
    await vi.waitFor(() => {
      const save = calls.find((c) => c.cmd === "config_save");
      expect(save).toBeDefined();
      expect(
        (save!.args.config as { session: { autosaveOnExit: boolean } }).session.autosaveOnExit
      ).toBe(!defaultConfig().session.autosaveOnExit);
    });
  });

  it("Export forwards the path to config_export", async () => {
    captureWith();
    const config = createConfigStore();
    const { container } = render(SettingsPanel, {
      props: { open: true, config, onclose: vi.fn() },
    });
    const pathInput = container.querySelector(
      '[data-testid="settings-export-path"]'
    ) as HTMLInputElement;
    await fireEvent.input(pathInput, { target: { value: "/tmp/relay.toml" } });
    await fireEvent.click(
      container.querySelector('[data-testid="settings-export"]') as HTMLElement
    );
    await vi.waitFor(() => {
      const exp = calls.find((c) => c.cmd === "config_export");
      expect(exp).toBeDefined();
      expect(exp!.args).toEqual({ path: "/tmp/relay.toml" });
    });
  });

  it("Import calls config_import and then config_save", async () => {
    captureWith((cmd) => {
      if (cmd === "config_import") {
        return { ...defaultConfig(), font: { family: "Iosevka", size: 14 } };
      }
      return undefined;
    });
    const config = createConfigStore();
    const { container } = render(SettingsPanel, {
      props: { open: true, config, onclose: vi.fn() },
    });
    const pathInput = container.querySelector(
      '[data-testid="settings-import-path"]'
    ) as HTMLInputElement;
    await fireEvent.input(pathInput, { target: { value: "/tmp/relay.toml" } });
    await fireEvent.click(
      container.querySelector('[data-testid="settings-import"]') as HTMLElement
    );
    await vi.waitFor(() => {
      expect(calls.find((c) => c.cmd === "config_import")).toBeDefined();
      expect(calls.find((c) => c.cmd === "config_save")).toBeDefined();
    });
    // The store should now reflect the imported value.
    expect(config.current.font.family).toBe("Iosevka");
  });
});
