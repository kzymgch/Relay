import { test, expect } from "@playwright/test";

import { installMockIpc } from "./support/mock-ipc";

test.describe("keybind", () => {
  test("default cmd+p opens the command palette", async ({ page }) => {
    await installMockIpc(page);
    await page.goto("/");

    await page.keyboard.press("Meta+P");
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

    // Old combo no longer opens the palette.
    await page.keyboard.press("Meta+P");
    await expect(page.getByTestId("command-palette")).toBeHidden();

    // New combo does.
    await page.keyboard.press("Meta+Shift+KeyP");
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
        // palette.open and settings.open both bound to cmd+p.
        keybind: { "palette.open": "cmd+p", "settings.open": "cmd+p" },
        defaultPane: { label: "Pane", command: "/bin/zsh", args: ["-l"], cwd: null, env: {} },
        pane: { preset: [] },
      },
    });
    await page.goto("/");
    await page.keyboard.press("Meta+Comma");
    await expect(page.getByTestId("settings-keybind-conflicts")).toBeVisible();
  });
});
