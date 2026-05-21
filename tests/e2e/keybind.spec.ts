import { test, expect } from "@playwright/test";

import { installMockIpc } from "./support/mock-ipc";
import { pressShortcut, waitForLayout } from "./support/helpers";

test.describe("keybind", () => {
  test("default cmd+p opens the command palette", async ({ page }) => {
    await installMockIpc(page);
    await page.goto("/");
    await waitForLayout(page);

    await pressShortcut(page, { code: "KeyP", metaKey: true });
    await expect(page.getByTestId("command-palette")).toBeVisible();
  });

  test("a custom override remaps palette.open", async ({ page }) => {
    await installMockIpc(page, {
      config: {
        font: { family: "Menlo", size: 13 },
        theme: { preset: "dark", transparent: false, custom: null },
        send: { bracketedPaste: true, trailingNewline: false, previewBeforeSend: false },
        scrollback: { lines: 10000, persistOnExit: false, persistMaxBytes: 1048576 },
        session: { autosaveOnExit: false, restoreOnLaunch: false },
        logging: {
          enabled: false,
          dir: "",
          mode: "plain",
          maxBytes: 0,
          maxFiles: 0,
          dailyRotation: true,
          secrets: [],
        },
        keybind: { "palette.open": "cmd+shift+p" },
        defaultPane: { label: "Pane", command: "/bin/zsh", args: ["-l"], cwd: null, env: {} },
        pane: { preset: [] },
      },
    });
    await page.goto("/");
    await waitForLayout(page);

    // Old combo no longer opens the palette.
    await pressShortcut(page, { code: "KeyP", metaKey: true });
    await expect(page.getByTestId("command-palette")).toBeHidden();

    // New combo does.
    await pressShortcut(page, { code: "KeyP", metaKey: true, shiftKey: true });
    await expect(page.getByTestId("command-palette")).toBeVisible();
  });

  test("conflicting bindings surface a banner in the settings panel", async ({ page }) => {
    await installMockIpc(page, {
      config: {
        font: { family: "Menlo", size: 13 },
        theme: { preset: "dark", transparent: false, custom: null },
        send: { bracketedPaste: true, trailingNewline: false, previewBeforeSend: false },
        scrollback: { lines: 10000, persistOnExit: false, persistMaxBytes: 1048576 },
        session: { autosaveOnExit: false, restoreOnLaunch: false },
        logging: {
          enabled: false,
          dir: "",
          mode: "plain",
          maxBytes: 0,
          maxFiles: 0,
          dailyRotation: true,
          secrets: [],
        },
        // Conflict on a pane action, not on settings.open — otherwise
        // remapping settings.open would make Cmd+, fail to open the panel
        // and the banner would be inside a modal we can't reach.
        keybind: { "pane.clear": "cmd+x", "pane.restart": "cmd+x" },
        defaultPane: { label: "Pane", command: "/bin/zsh", args: ["-l"], cwd: null, env: {} },
        pane: { preset: [] },
      },
    });
    await page.goto("/");
    await waitForLayout(page);
    await pressShortcut(page, { code: "Comma", metaKey: true });
    await expect(page.getByTestId("settings-panel")).toBeVisible();
    await expect(page.getByTestId("settings-keybind-conflicts")).toBeVisible();
  });
});
