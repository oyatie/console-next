// SPDX-License-Identifier: LicenseRef-Proprietary
import { afterAll, beforeAll, expect, test } from "vitest";
import { expect as element } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { i18n, loadCatalog, t } from "@console/i18n";
import { browserTestOptimizeDeps, chromium, openBrowserTestPage, type Browser, type Page } from "../../lib/browser-test";
import { SINGLE_KEYS_KEY } from "../../lib/prefs";

const [fixture] = Object.values(import.meta.glob<string>("./single-keys-check.browser-fixture.tsx", { query: "?url", import: "default", eager: true }));
let server: ViteDevServer;
let browser: Browser;
let page: Page;
beforeAll(async () => {
  await loadCatalog("en");
  i18n.set("en");
  server = await createServer({ configFile: false, cacheDir: ".cache/single-keys-check-test", logLevel: "error",
    optimizeDeps: { ...browserTestOptimizeDeps, entries: ["apps/web/src/shell/frame/single-keys-check.browser-fixture.tsx"] },
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, fs: { allow: [process.cwd()] } },
  });
  await server.listen();
  browser = await chromium.launch();
  page = await browser.newPage();
  await page.route("**/single-keys-test", route => route.fulfill({ contentType: "text/html", body: `<html lang="en"><title>Single keys</title><div id="root"></div><script type="module" src="${fixture}"></script></html>` }));
}, 120_000);
afterAll(async () => { i18n.set("ko"); await browser?.close(); await server?.close(); });

const box = () => page.getByRole("checkbox", { name: t("account.singleKeys"), exact: true });
const open = () => openBrowserTestPage(page, `${server.resolvedUrls!.local[0]}single-keys-test`, box());
const stored = () => page.evaluate(key => localStorage.getItem(key), SINGLE_KEYS_KEY);

test("single keys are on by default; unchecking stores off on this device and checking removes it", async () => {
  await open();
  await element(box()).toBeChecked();
  await element(page.getByText(t("account.singleKeys"), { exact: true })).toBeVisible();
  await element(box()).toHaveAccessibleDescription(t("account.singleKeys.device"));
  expect(t("account.singleKeys.device")).toContain("this device");
  expect(await stored()).toBeNull();

  await box().uncheck();
  expect(await stored()).toBe("off");
  // The stored choice is what the control shows on the next visit.
  await open();
  await element(box()).not.toBeChecked();

  await box().check();
  expect(await stored()).toBeNull();
  await element(page.getByRole("alert")).toHaveCount(0);
}, 60_000);

test("a device that refuses to store the choice says so and leaves the box as it was", async () => {
  await open();
  await page.evaluate(() => { Storage.prototype.setItem = () => { throw new Error("storage is refused"); }; });
  await box().click();
  await element(page.getByRole("alert")).toHaveText(t("account.singleKeys.failed"));
  await element(box()).toBeChecked();
}, 60_000);
