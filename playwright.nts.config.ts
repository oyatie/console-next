// SPDX-License-Identifier: LicenseRef-Proprietary
import { defineConfig } from "@playwright/test";
import { SLOT } from "./e2e/slot";
import config from "./playwright.config";

const ntsPort = Number(process.env.NTS_FAKE_PORT ?? 18125 + SLOT * 10);
const fakeUrl = `http://127.0.0.1:${ntsPort}`;

process.env.NTS_FAKE_URL = fakeUrl;

export default defineConfig({
  ...config,
  forbidOnly: !!process.env.CI,
  testIgnore: [],
  testMatch: ["**/entity-nts-check.spec.ts"],
  grep: /checks NTS explicitly/,
  workers: 1,
  webServer: [
    {
      command: "node e2e/helpers/nts-fake.mjs",
      wait: { stdout: /NTS_FAKE_URL=/ },
      gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
      env: { NTS_FAKE_PORT: String(ntsPort) },
    },
    ...(config.webServer ?? []).map((server) =>
      server.command.includes("backend-dev.mjs")
        ? {
            ...server,
            env: {
              ...server.env,
              NTS_BASE_URL: `${fakeUrl}/api/nts-businessman/v1/`,
              NTS_BUSINESSMAN_API_KEY: "e2e-nts-fake-key",
              NTS_BUSINESSMAN_API_KEY_EXPIRES_ON: "2099-12-31",
            },
          }
        : server,
    ),
  ],
});
