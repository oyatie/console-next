// SPDX-License-Identifier: LicenseRef-Proprietary
import { defineConfig } from "@playwright/test";
import config from "./playwright.config";

export default defineConfig({
  ...config,
  forbidOnly: !!process.env.CI,
  testIgnore: [],
  webServer: config.webServer?.map((server) => ({
    ...server,
    env: { ...server.env, CONSOLE_E2E_ACCESS_TOKEN_TTL_SECS: "180" },
  })),
  testMatch: ["**/live-renew.server-expiry.spec.ts"],
});
