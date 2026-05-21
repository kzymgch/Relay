import { test, expect } from "@playwright/test";

import { installMockIpc } from "./support/mock-ipc";
import { waitForLayout } from "./support/helpers";

test.describe("boot", () => {
  test("app boots into a three-pane layout with the status bar visible", async ({ page }) => {
    await installMockIpc(page);
    await page.goto("/");
    await waitForLayout(page);
    await expect(page.locator(".status-bar")).toBeVisible();
  });
});
