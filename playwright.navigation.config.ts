// SPDX-License-Identifier: LicenseRef-Proprietary
import { defineConfig } from "@playwright/test";

// The navigation control uses the real router with gated fixture reads; no backend or tenant is needed.
export default defineConfig({
  testDir: "e2e",
  testMatch: "navigation-ready.spec.ts",
  outputDir: ".cache/navigation-results",
  workers: 1,
  use: { trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }, { name: "firefox", use: { browserName: "firefox" } }],
});
