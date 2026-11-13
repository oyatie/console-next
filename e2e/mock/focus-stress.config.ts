// SPDX-License-Identifier: LicenseRef-Proprietary
import { defineConfig } from "@playwright/test";
import config from "./playwright.config";
import { e2eBrowser } from "../browser";
export default defineConfig({ ...config,
  testMatch: ["mock/dept-head.spec.ts", "mock/route-focus-title.spec.ts"],
  forbidOnly: !!process.env.CI,
  projects: [{ name: e2eBrowser() }],
  reporter: [["line"], ["json", { outputFile: process.env.FOCUS_REPORT }]],
});
