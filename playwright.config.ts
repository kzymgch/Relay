// Playwright browser-smoke config.
//
// Boots a Vite dev server, then loads the SPA in chromium with the Tauri IPC
// surface stubbed by `tests/e2e/support/mock-ipc.ts`. The scope is the
// front-end's IPC contract, key dispatch, and DOM-level theme/send wiring;
// real PTYs and real config persistence are covered by the manual smoke
// checklist (`scripts/manual-smoke.md`).

import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://localhost:1420",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "pnpm dev",
    url: "http://localhost:1420",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
