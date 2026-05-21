import { test, expect } from "@playwright/test";

import { installMockIpc } from "./support/mock-ipc";

test.describe("session", () => {
  test("saving a session via the palette adds an entry that load can find", async ({ page }) => {
    await installMockIpc(page);
    await page.goto("/");

    // Open palette via Cmd+P, search for "Save session", run it.
    await page.keyboard.press("Meta+P");
    await expect(page.getByTestId("command-palette")).toBeVisible();

    const search = page.locator(".palette-search input");
    await search.fill("save session");

    // Stub `prompt()` so the palette's "Save session as…" action gets a name.
    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).prompt = () => "smoke";
    });

    // Pick the first matching row.
    await page.locator(".palette-row").first().click();
    await expect(page.getByTestId("command-palette")).toBeHidden();

    // Open palette again, type "Load session", confirm the new entry is there.
    await page.keyboard.press("Meta+P");
    await search.fill("load session: smoke");
    await expect(page.locator(".palette-row").first()).toContainText("smoke");
  });
});
