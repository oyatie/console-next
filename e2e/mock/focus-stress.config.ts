// SPDX-License-Identifier: LicenseRef-Proprietary
import { defineConfig } from "@playwright/test";
import config from "./playwright.config";
import { e2eBrowser } from "../browser";
import { BASELINE } from "../experience";
export default defineConfig({ ...config,
  testMatch: ["mock/dept-head.spec.ts", "mock/route-focus-title.spec.ts"],
  forbidOnly: !!process.env.CI,
  // Focus is behaviour, so it is stressed in the shipped default; Classic-look pins stay in the states suite.
  projects: [{ name: e2eBrowser(), grepInvert: BASELINE }],
  reporter: [["line"], ["json", { outputFile: process.env.FOCUS_REPORT }]],
});
