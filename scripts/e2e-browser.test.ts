// SPDX-License-Identifier: LicenseRef-Proprietary
import { afterEach, expect, test, vi } from "vitest";

vi.mock("vite", () => ({ createServer: vi.fn(async () => ({ listen: vi.fn() })) }));
vi.mock("@console/i18n", () => ({ loadCatalog: vi.fn() }));
vi.mock("@playwright/test", async importOriginal => ({ ...await importOriginal<typeof import("@playwright/test")>(), ...Object.fromEntries(["chromium", "firefox", "webkit"].map(name => [name, {
  name: () => name,
  launch: vi.fn(async () => ({ newContext: async () => ({ newPage: async () => ({}) }) })),
}])) }));

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

test.each(["chromium", "firefox", "webkit"])("table fixtures launch %s", async name => {
  vi.stubEnv("E2E_BROWSER", name);
  const engines = await import("@playwright/test");
  vi.clearAllMocks();
  const { tableTest } = await import("../e2e/long-table-fixture");
  await tableTest();
  for (const engine of [engines.chromium, engines.firefox, engines.webkit]) {
    expect(engine.launch).toHaveBeenCalledTimes(engine.name() === name ? 1 : 0);
  }
});

test.each(["chromium", "firefox", "webkit"])("browser component fixtures select %s", async name => {
  vi.stubEnv("E2E_BROWSER", name);
  const { browserEngine } = await import("../apps/web/src/lib/browser-test");
  expect(browserEngine().name()).toBe(name);
});

test.each(["chromium", "firefox", "webkit"])("specialized configs select %s", async name => {
  vi.stubEnv("E2E_BROWSER", name);
  const { default: grid } = await import("../apps/web/src/features/people/ui/grid-table.playwright");
  const { default: timeline } = await import("../apps/web/src/ui/timeline-lanes/timeline-line.playwright");
  const { default: focus } = await import("../e2e/mock/focus-stress.config");
  const { default: navigation } = await import("../playwright.navigation.config");
  expect(grid.use?.browserName).toBe(name);
  for (const config of [timeline, focus, navigation]) {
    expect(config.projects?.map(project => project.use?.browserName ?? config.use?.browserName)).toEqual([name]);
  }
});
