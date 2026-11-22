// SPDX-License-Identifier: LicenseRef-Proprietary
import { defineConfig } from "@playwright/test";
import { SLOT } from "./e2e/slot";
import config from "./playwright.config";

const ntsPort = Number(process.env.NTS_FAKE_PORT ?? 18125 + SLOT * 10);
const fakeUrl = process.env.NTS_FAKE_URL ?? `http://127.0.0.1:${ntsPort}`;
const baseUrl = process.env.NTS_BASE_URL ?? `${fakeUrl}/api/nts-businessman/v1/`;
const apiKey = process.env.NTS_BUSINESSMAN_API_KEY ?? "e2e-nts-fake-key";
const apiKeyExpiresOn = process.env.NTS_BUSINESSMAN_API_KEY_EXPIRES_ON ?? "2099-12-31";

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
              NTS_BASE_URL: baseUrl,
              NTS_BUSINESSMAN_API_KEY: apiKey,
              NTS_BUSINESSMAN_API_KEY_EXPIRES_ON: apiKeyExpiresOn,
            },
          }
        : server,
    ),
  ],
});
