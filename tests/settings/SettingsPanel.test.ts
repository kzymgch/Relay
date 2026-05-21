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

  it("adds and removes pane presets and persists the args list on save", async () => {
    captureWith();
    const config = createConfigStore();
    const { container } = render(SettingsPanel, {
      props: { open: true, config, onclose: vi.fn() },
    });
    // Initially no presets — count remove buttons (one per row).
    expect(container.querySelectorAll('[data-testid^="settings-pane-preset-remove-"]').length).toBe(
      0
    );
    // Click "Add preset" twice.
    const addBtn = container.querySelector(
      '[data-testid="settings-pane-preset-add"]'
    ) as HTMLElement;
    await fireEvent.click(addBtn);
    await fireEvent.click(addBtn);
    // Two rows now exist; tweak the first row's command + args.
    const command0 = container.querySelector(
      '[data-testid="settings-pane-preset-command-0"]'
    ) as HTMLInputElement;
    const args0 = container.querySelector(
      '[data-testid="settings-pane-preset-args-0"]'
    ) as HTMLInputElement;
    await fireEvent.input(command0, { target: { value: "pnpm" } });
    await fireEvent.input(args0, { target: { value: "test --watch" } });
    // Remove the second preset.
    const remove1 = container.querySelector(
      '[data-testid="settings-pane-preset-remove-1"]'
    ) as HTMLElement;
    await fireEvent.click(remove1);
    // Save.
    await fireEvent.click(container.querySelector('[data-testid="settings-save"]') as HTMLElement);
    await vi.waitFor(() => {
      const save = calls.find((c) => c.cmd === "config_save");
      expect(save).toBeDefined();
      const cfg = save!.args.config as { pane: { preset: { command: string; args: string[] }[] } };
      expect(cfg.pane.preset).toHaveLength(1);
      expect(cfg.pane.preset[0]!.command).toBe("pnpm");
      expect(cfg.pane.preset[0]!.args).toEqual(["test", "--watch"]);
    });
  });

  it("Theme preset dropdown writes through to config_save", async () => {
    captureWith();
    const config = createConfigStore();
    const { container } = render(SettingsPanel, {
      props: { open: true, config, onclose: vi.fn() },
    });
    const select = container.querySelector(
      '[data-testid="settings-theme-preset"]'
    ) as HTMLSelectElement;
    expect(select.value).toBe("dark");
    select.value = "solarized-dark";
    await fireEvent.change(select);
    await fireEvent.click(container.querySelector('[data-testid="settings-save"]') as HTMLElement);
    await vi.waitFor(() => {
      const save = calls.find((c) => c.cmd === "config_save");
      expect(save).toBeDefined();
      expect((save!.args.config as { theme: { preset: string } }).theme.preset).toBe(
        "solarized-dark"
      );
    });
  });

  it("Selecting Custom preset reveals the colour pickers and round-trips through save", async () => {
    captureWith();
    const config = createConfigStore();
    const { container } = render(SettingsPanel, {
      props: { open: true, config, onclose: vi.fn() },
    });
    const select = container.querySelector(
      '[data-testid="settings-theme-preset"]'
    ) as HTMLSelectElement;
    select.value = "custom";
    await fireEvent.change(select);
    const customBlock = container.querySelector(
      '[data-testid="settings-theme-custom"]'
    ) as HTMLElement;
    expect(customBlock).toBeTruthy();
    const bgInput = container.querySelector(
      '[data-testid="settings-theme-xterm-background"]'
    ) as HTMLInputElement;
    await fireEvent.input(bgInput, { target: { value: "#112233" } });
    await fireEvent.click(container.querySelector('[data-testid="settings-save"]') as HTMLElement);
    await vi.waitFor(() => {
      const save = calls.find((c) => c.cmd === "config_save");
      expect(save).toBeDefined();
      const cfg = save!.args.config as {
        theme: { preset: string; custom: { xterm: Record<string, string> } | null };
      };
      expect(cfg.theme.preset).toBe("custom");
      expect(cfg.theme.custom?.xterm.background).toBe("#112233");
    });
  });

  it("Keybind row records a fresh combo and persists it as an override", async () => {
    captureWith();
    const config = createConfigStore();
    const { container } = render(SettingsPanel, {
      props: { open: true, config, onclose: vi.fn() },
    });
    const recordBtn = container.querySelector(
      '[data-testid="settings-keybind-record-palette.open"]'
    ) as HTMLElement;
    await fireEvent.click(recordBtn);
    // Simulate the user pressing Cmd+Shift+P.
    window.dispatchEvent(
      new KeyboardEvent("keydown", { code: "KeyP", metaKey: true, shiftKey: true })
    );
    await fireEvent.click(container.querySelector('[data-testid="settings-save"]') as HTMLElement);
    await vi.waitFor(() => {
      const save = calls.find((c) => c.cmd === "config_save");
      expect(save).toBeDefined();
      const map = (save!.args.config as { keybind: Record<string, string> }).keybind;
      expect(map["palette.open"]).toBe("cmd+shift+p");
    });
  });

  it("Clicking Record on a second row cancels the first arm (only one row gets the next keypress)", async () => {
    // Regression: each Record click used to append a listener and only
    // remove it on commit, so re-arming a different row caused both
    // listeners to fire on the next keystroke and commit the same combo
    // to two unrelated actions.
    captureWith();
    const config = createConfigStore();
    const { container } = render(SettingsPanel, {
      props: { open: true, config, onclose: vi.fn() },
    });
    await fireEvent.click(
      container.querySelector('[data-testid="settings-keybind-record-palette.open"]') as HTMLElement
    );
    await fireEvent.click(
      container.querySelector(
        '[data-testid="settings-keybind-record-settings.open"]'
      ) as HTMLElement
    );
    // Press a fresh combo. Only the second arm (settings.open) should
    // commit it; palette.open keeps its default.
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "F9" }));
    await fireEvent.click(container.querySelector('[data-testid="settings-save"]') as HTMLElement);
    await vi.waitFor(() => {
      const save = calls.find((c) => c.cmd === "config_save");
      expect(save).toBeDefined();
      const map = (save!.args.config as { keybind: Record<string, string> }).keybind;
      expect(map["settings.open"]).toBe("f9");
      expect(map["palette.open"]).toBeUndefined();
    });
  });

  it("Closing the panel cancels a pending Record arm (no stray combo after re-open)", async () => {
    // Without the modal-close teardown, a Record arm survived a Cancel
    // click and the very next keystroke (e.g. typing into the terminal)
    // would silently commit to the previously-armed action.
    captureWith();
    const config = createConfigStore();
    let onclose = vi.fn();
    const { container, rerender } = render(SettingsPanel, {
      props: { open: true, config, onclose },
    });
    await fireEvent.click(
      container.querySelector('[data-testid="settings-keybind-record-palette.open"]') as HTMLElement
    );
    // Close the modal — the recording listener must tear down.
    await rerender({ open: false, config, onclose });
    // Press a key. If the listener were still attached, it would write
    // "f9" into palette.open on the (now hidden) draft.
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "F9" }));

    // Re-open the modal and Save without further edits. The override map
    // should be empty.
    onclose = vi.fn();
    await rerender({ open: true, config, onclose });
    await fireEvent.click(container.querySelector('[data-testid="settings-save"]') as HTMLElement);
    await vi.waitFor(() => {
      const save = calls.find((c) => c.cmd === "config_save");
      expect(save).toBeDefined();
      const map = (save!.args.config as { keybind: Record<string, string> }).keybind;
      expect(map).toEqual({});
    });
  });

  it("Saving Custom preset without any picker edits emits an empty payload (passes Rust validation)", async () => {
    // Regression: buildCustomPayload used to return null when the
    // customColours map was empty, but Rust validation requires
    // theme.custom to be Some whenever theme.preset is "custom". The
    // settings UI looked valid but every save failed.
    captureWith();
    const config = createConfigStore();
    const { container } = render(SettingsPanel, {
      props: { open: true, config, onclose: vi.fn() },
    });
    const select = container.querySelector(
      '[data-testid="settings-theme-preset"]'
    ) as HTMLSelectElement;
    select.value = "custom";
    await fireEvent.change(select);
    await fireEvent.click(container.querySelector('[data-testid="settings-save"]') as HTMLElement);
    await vi.waitFor(() => {
      const save = calls.find((c) => c.cmd === "config_save");
      expect(save).toBeDefined();
      const theme = (
        save!.args.config as {
          theme: {
            preset: string;
            custom: { xterm: Record<string, string>; chrome: Record<string, string> } | null;
          };
        }
      ).theme;
      expect(theme.preset).toBe("custom");
      expect(theme.custom).not.toBeNull();
      expect(theme.custom).toEqual({ xterm: {}, chrome: {} });
    });
  });

  it("Reset clears a recorded override so save emits no entry for it", async () => {
    captureWith();
    const config = createConfigStore();
    const { container } = render(SettingsPanel, {
      props: { open: true, config, onclose: vi.fn() },
    });
    // Record then reset.
    await fireEvent.click(
      container.querySelector('[data-testid="settings-keybind-record-palette.open"]') as HTMLElement
    );
    window.dispatchEvent(
      new KeyboardEvent("keydown", { code: "KeyP", metaKey: true, shiftKey: true })
    );
    await fireEvent.click(
      container.querySelector('[data-testid="settings-keybind-reset-palette.open"]') as HTMLElement
    );
    await fireEvent.click(container.querySelector('[data-testid="settings-save"]') as HTMLElement);
    await vi.waitFor(() => {
      const save = calls.find((c) => c.cmd === "config_save");
      expect(save).toBeDefined();
      const map = (save!.args.config as { keybind: Record<string, string> }).keybind;
      expect(map["palette.open"]).toBeUndefined();
    });
  });

  it("initialSection prop scrolls the matching section into view", async () => {
    captureWith();
    const config = createConfigStore();
    const scrollSpy = vi.fn();
    // jsdom's scrollIntoView is a no-op; spy on the prototype to confirm
    // the panel called it on the right element.
    Element.prototype.scrollIntoView = scrollSpy as typeof Element.prototype.scrollIntoView;
    const { container } = render(SettingsPanel, {
      props: { open: true, config, onclose: vi.fn(), initialSection: "scrollback" },
    });
    await vi.waitFor(() => {
      expect(scrollSpy).toHaveBeenCalled();
    });
    // The `highlight` class should land on the matching section.
    const section = container.querySelector('[data-testid="settings-scrollback"]') as HTMLElement;
    expect(section.classList.contains("highlight")).toBe(true);
  });

  it("Import refreshes the raw args strings so the next Save preserves imported pane args", async () => {
    // Regression: previously, onImport replaced `draft` but left the
    // raw-string mirrors stale. The subsequent Save re-derived args from
    // the stale strings and clobbered the imported pane definitions.
    captureWith((cmd) => {
      if (cmd === "config_import") {
        const cfg = defaultConfig();
        cfg.defaultPane.args = ["-lic", "newer"];
        cfg.pane.preset = [
          {
            label: "lint",
            command: "pnpm",
            args: ["lint", "--fix"],
            cwd: null,
            env: {},
          },
        ];
        return cfg;
      }
      return undefined;
    });
    const config = createConfigStore();
    const { container } = render(SettingsPanel, {
      props: { open: true, config, onclose: vi.fn() },
    });
    // Trigger Import.
    const pathInput = container.querySelector(
      '[data-testid="settings-import-path"]'
    ) as HTMLInputElement;
    await fireEvent.input(pathInput, { target: { value: "/tmp/relay.toml" } });
    await fireEvent.click(
      container.querySelector('[data-testid="settings-import"]') as HTMLElement
    );
    await vi.waitFor(() => {
      const argsInput = container.querySelector(
        '[data-testid="settings-default-args"]'
      ) as HTMLInputElement;
      expect(argsInput.value).toBe("-lic newer");
    });
    // The preset row 0 args input must also reflect the imported args.
    const presetArgs = container.querySelector(
      '[data-testid="settings-pane-preset-args-0"]'
    ) as HTMLInputElement;
    expect(presetArgs.value).toBe("lint --fix");

    // Now Save: the persisted config should match the imported args
    // exactly, NOT the stale (originally empty) form values.
    calls.length = 0;
    await fireEvent.click(container.querySelector('[data-testid="settings-save"]') as HTMLElement);
    await vi.waitFor(() => {
      const save = calls.find((c) => c.cmd === "config_save");
      expect(save).toBeDefined();
      const cfg = save!.args.config as {
        defaultPane: { args: string[] };
        pane: { preset: { args: string[] }[] };
      };
      expect(cfg.defaultPane.args).toEqual(["-lic", "newer"]);
      expect(cfg.pane.preset[0]!.args).toEqual(["lint", "--fix"]);
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
    // The reactive `current` swap happens *after* `config_save` resolves
    // (a deliberate ordering — we don't leak unvalidated state). Wait for
    // the post-save update before asserting.
    await vi.waitFor(() => {
      expect(config.current.font.family).toBe("Iosevka");
    });
  });

  it("Logging section round-trips enabled / mode / secrets through config_save", async () => {
    captureWith();
    const config = createConfigStore();
    const { container } = render(SettingsPanel, {
      props: { open: true, config, onclose: vi.fn() },
    });
    const enabled = container.querySelector(
      '[data-testid="settings-logging-enabled"]'
    ) as HTMLInputElement;
    const mode = container.querySelector(
      '[data-testid="settings-logging-mode"]'
    ) as HTMLSelectElement;
    const secrets = container.querySelector(
      '[data-testid="settings-logging-secrets"]'
    ) as HTMLTextAreaElement;
    await fireEvent.click(enabled);
    mode.value = "raw";
    await fireEvent.change(mode);
    await fireEvent.input(secrets, {
      target: { value: "sk-[A-Za-z0-9]+\nbearer .+" },
    });
    await fireEvent.click(container.querySelector('[data-testid="settings-save"]') as HTMLElement);
    await vi.waitFor(() => {
      const save = calls.find((c) => c.cmd === "config_save");
      expect(save).toBeDefined();
      const cfg = save!.args.config as {
        logging: {
          enabled: boolean;
          mode: string;
          secrets: string[];
        };
      };
      expect(cfg.logging.enabled).toBe(true);
      expect(cfg.logging.mode).toBe("raw");
      expect(cfg.logging.secrets).toEqual(["sk-[A-Za-z0-9]+", "bearer .+"]);
    });
  });
});
