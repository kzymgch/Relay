import { test, expect } from "@playwright/test";

import { installMockIpc } from "./support/mock-ipc";
import { waitForLayout } from "./support/helpers";

test.describe("send", () => {
  test("DnD drop on a sibling pane opens the preview modal with the dropped text", async ({
    page,
  }) => {
    await installMockIpc(page);
    await page.goto("/");
    await waitForLayout(page);

    // Synthesise a drop event with the relay DnD MIME on pane 2 — exercises
    // the same `routeSend` path Cmd+Shift+N would hit, without depending on
    // a live xterm selection (xterm selection in headless chromium needs a
    // rendered canvas).
    const handled = await page.evaluate(() => {
      const panes = document.querySelectorAll(".pane");
      const target = panes[1] as HTMLElement | undefined;
      if (!target) return false;
      const dt = new DataTransfer();
      dt.setData("text/plain", "echo hello\n");
      dt.setData(
        "application/x-relay-send",
        JSON.stringify({ sourcePaneId: "fake-source", sourceLabel: "Source" })
      );
      const drop = new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt });
      target.dispatchEvent(drop);
      return true;
    });
    expect(handled).toBe(true);

    await expect(page.getByTestId("send-preview")).toBeVisible();
    await expect(page.getByTestId("send-preview-text")).toHaveText("echo hello\n");

    await page.getByTestId("send-preview-send").click();
    await expect(page.getByTestId("send-preview")).toBeHidden();
  });
});
