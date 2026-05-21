import { test, expect } from "@playwright/test";

import { installMockIpc } from "./support/mock-ipc";
import { waitForLayout } from "./support/helpers";

test.describe("panes modal", () => {
  test("toolbar button opens the modal with one tab per pane and Save updates the live label", async ({
    page,
  }) => {
    await installMockIpc(page);
    await page.goto("/");
    await waitForLayout(page);

    // The per-pane gear button is gone.
    await expect(page.locator('button[aria-label="Pane settings"]')).toHaveCount(0);

    // Open from the toolbar.
    await page.getByTestId("panes-toolbar-toggle").click();
    await expect(page.getByTestId("panes-panel")).toBeVisible();

    // Three pane tabs surface (matching the default three-pane preset).
    const tabs = page.locator(".panes-tab");
    await expect(tabs).toHaveCount(3);
    // The focused pane (Pane 1) is selected by default.
    await expect(tabs.first()).toHaveClass(/active/);

    // Rename the second pane (slot-top-right in the default preset) and save.
    await tabs.nth(1).click();
    const labelField = page.getByTestId("panes-field-label");
    await labelField.fill("Logs");
    await page.getByTestId("panes-save").click();

    // The renamed pane's header reflects the new label without restarting
    // the PTY. DOM order is store-insertion order, not visual order, so
    // we assert against the array of header labels.
    const labels = page.locator(".pane header .label");
    await expect(labels).toHaveText(["Pane 1", "Logs", "Pane 3"]);
  });
});
