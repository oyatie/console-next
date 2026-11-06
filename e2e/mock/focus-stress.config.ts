// SPDX-License-Identifier: LicenseRef-Proprietary
import { defineConfig } from "@playwright/test";
import config from "./playwright.config";
export default defineConfig({ ...config,
  testMatch: "mock/route-focus-title.spec.ts",
  forbidOnly: !!process.env.CI,
  projects: ["chromium", "firefox"].map(browserName => ({ name: browserName, use: { browserName: browserName as "chromium" | "firefox" } })),
  reporter: [["line"], ["json", { outputFile: process.env.FOCUS_REPORT }]],
});
