import { test, expect } from "@playwright/test";

import { installMockIpc } from "./support/mock-ipc";

test.describe("boot", () => {
  test("app boots into a three-pane layout with the status bar visible", async ({ page }) => {
    await installMockIpc(page);
    await page.goto("/");
    // Default preset is three panes. Pane headers render the label "Pane X".
    await expect(page.locator("[data-testid='pane-status']")).toHaveCount(3);
    // Status bar visible at the bottom.
    await expect(page.locator(".status-bar")).toBeVisible();
  });
});
