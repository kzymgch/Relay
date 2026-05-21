import { test, expect } from "@playwright/test";

import { installMockIpc } from "./support/mock-ipc";
import { pressShortcut, waitForLayout } from "./support/helpers";

test.describe("session", () => {
  test("saving a session via the palette adds an entry that load can find", async ({ page }) => {
    // Stub `window.prompt` before navigation. Playwright auto-dismisses
    // native dialogs (returning `null`), and the JS-side override has to
    // be installed via `addInitScript` so it's in place when the page's
    // hydration first reaches `saveSession`. A subsequent reload makes
    // sure the override is on the snapshot we then interact with.
    await page.addInitScript(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).prompt = () => "smoke";
    });
    await installMockIpc(page);
    await page.goto("/");
    await waitForLayout(page);

    // Open palette via Cmd+P and pick the save action by its stable id.
    await pressShortcut(page, { code: "KeyP", metaKey: true });
    await expect(page.getByTestId("command-palette")).toBeVisible();
    await page.getByTestId("command-palette-row-session.save").click({ force: true });
    await expect(page.getByTestId("command-palette")).toBeHidden();

    // Reopen the palette. `openPalette` awaits `refreshSessions`, so the
    // freshly-saved "smoke" entry must be visible as a load row.
    await pressShortcut(page, { code: "KeyP", metaKey: true });
    await expect(page.getByTestId("command-palette")).toBeVisible();
    await expect(page.getByTestId("command-palette-row-session.load.smoke")).toBeVisible();
  });
});
