// Shared test helpers.
//
// `pressShortcut` dispatches a synthetic `keydown` via `page.evaluate` so the
// event reaches the window-level listener directly. Playwright's
// `page.keyboard.press` goes through Chromium's input pipeline, which on
// macOS intercepts accelerator-level combos (Cmd+P, Cmd+,) at the browser
// chrome layer before they bubble to page JS — that produces "element not
// found" failures even though the listener is wired correctly.
//
// `waitForLayout` blocks until AppRoot's `onMount` has run and the three
// panes are visible. Until then the window keydown listener isn't yet
// attached, so any earlier dispatch is silently dropped.

import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";

export interface ShortcutInit {
  /** KeyboardEvent.code — e.g. `"KeyP"`, `"Digit2"`, `"Comma"`, `"Equal"`. */
  code: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

export async function pressShortcut(page: Page, init: ShortcutInit): Promise<void> {
  await page.evaluate((args: ShortcutInit) => {
    const event = new KeyboardEvent("keydown", {
      ...args,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(event);
  }, init);
}

export async function waitForLayout(page: Page): Promise<void> {
  await expect(page.locator("[data-testid='pane-status']")).toHaveCount(3);
}
