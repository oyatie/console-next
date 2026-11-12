// SPDX-License-Identifier: LicenseRef-Proprietary
import { afterEach, expect, test, vi } from "vitest";

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

test.each([
  [undefined, undefined, "chromium"],
  [undefined, "0", "chromium"],
  [undefined, "1", "firefox"],
  ["chromium", "1", "chromium"],
  ["firefox", "0", "firefox"],
  ["webkit", "1", "webkit"],
])("mock and live configs share browser selection (%s, legacy %s)", async (browser, legacy, expected) => {
  vi.stubEnv("E2E_BROWSER", browser);
  vi.stubEnv("E2E_XBROWSER", legacy);
  const { default: mock } = await import("../e2e/mock/playwright.config");
  const { default: live } = await import("../playwright.config");
  expect(mock.use?.browserName).toBe(expected);
  expect(live.use?.browserName).toBe(expected);
  expect(live.projects?.map(project => project.name)).toEqual(expected === "chromium" ? ["parallel", "clock"] : [expected]);
  if (expected !== "chromium") {
    expect(live.projects?.[0]?.grepInvert).toEqual(expect.arrayContaining([/@clock/]));
    expect(live.testIgnore).toEqual(expect.arrayContaining([/visual\.spec\.ts/]));
  }
});

test.each(["", "safari", "webkti"])("an invalid browser %j fails instead of silently running Chromium", async browser => {
  vi.stubEnv("E2E_BROWSER", browser);
  await expect(import("../e2e/mock/playwright.config")).rejects.toThrow("E2E_BROWSER must be chromium, firefox or webkit");
  await expect(import("../playwright.config")).rejects.toThrow("E2E_BROWSER must be chromium, firefox or webkit");
});
