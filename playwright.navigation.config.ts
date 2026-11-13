// SPDX-License-Identifier: LicenseRef-Proprietary
import { defineConfig } from "@playwright/test";
import { e2eBrowser } from "./e2e/browser";

// The navigation control uses the real router with gated fixture reads; no backend or tenant is needed.
export default defineConfig({
  testDir: "e2e",
  testMatch: "navigation-ready.spec.ts",
  outputDir: ".cache/navigation-results",
  forbidOnly: !!process.env.CI,
  workers: 1,
  use: { trace: "retain-on-failure" },
  projects: [{ name: e2eBrowser(), use: { browserName: e2eBrowser() } }],
});
