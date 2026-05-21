import { test, expect } from "@playwright/test";

import { installMockIpc, recordedCalls } from "./support/mock-ipc";
import { pressShortcut, waitForLayout } from "./support/helpers";

test.describe("theme", () => {
  test("switching the preset updates --relay-app-bg in <html>", async ({ page }) => {
    await installMockIpc(page);
    await page.goto("/");
    await waitForLayout(page);

    await pressShortcut(page, { code: "Comma", metaKey: true });
    await expect(page.getByTestId("settings-panel")).toBeVisible();

    // The default is dark; solarized-dark has a distinctly green-leaning bg.
    const before = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--relay-app-bg").trim()
    );
    await page.getByTestId("settings-theme-preset").selectOption("solarized-dark");
    await page.getByTestId("settings-save").click();

    await expect
      .poll(() =>
        page.evaluate(() =>
          getComputedStyle(document.documentElement).getPropertyValue("--relay-app-bg").trim()
        )
      )
      .not.toBe(before);
  });

  test("transparency toggle invokes set_window_vibrancy", async ({ page }) => {
    await installMockIpc(page);
    await page.goto("/");
    await waitForLayout(page);

    await pressShortcut(page, { code: "Comma", metaKey: true });
    await page.getByTestId("settings-theme-transparent").check();
    await page.getByTestId("settings-save").click();

    await expect
      .poll(async () => {
        const calls = await recordedCalls(page);
        return calls.some((c) => c.cmd === "set_window_vibrancy" && c.args.enabled === true);
      })
      .toBe(true);
  });
});
