// Playwright config for the html-collab-editor e2e suite.
//
// Each spec spins up its own editor server bound to a fresh copy of one of
// the fixture HTML files in tests/e2e/fixtures/. Tests are parallel-safe
// because each gets its own port and its own tempdir-backed file.
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? "list" : "list",
  timeout: 20_000,
  expect: { timeout: 5_000 },
  use: {
    headless: true,
    actionTimeout: 5_000,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
  ],
});
