// SPDX-License-Identifier: LicenseRef-Proprietary
import { realpathSync } from "node:fs";
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
let otherTab: Page;
beforeAll(async () => {
  await loadCatalog("en");
  i18n.set("en");
  server = await createServer({ configFile: false, cacheDir: ".cache/single-keys-check-test", logLevel: "error",
    optimizeDeps: { ...browserTestOptimizeDeps, entries: ["apps/web/src/shell/frame/single-keys-check.browser-fixture.tsx"] },
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, fs: { allow: [process.cwd(), realpathSync("node_modules/pretendard")] } },
  });
  await server.listen();
  browser = await chromium.launch();
  // Two tabs of one device: they share its storage.
  const device = await browser.newContext();
  page = await device.newPage();
  otherTab = await device.newPage();
  await device.route("**/single-keys-test", route => route.fulfill({ contentType: "text/html", body: `<html lang="en"><title>Single keys</title><div id="root"></div><script type="module" src="${fixture}"></script></html>` }));
}, 120_000);
afterAll(async () => { i18n.set("ko"); await browser?.close(); await server?.close(); });

const box = (tab = page) => tab.getByRole("switch", { name: t("account.singleKeys"), exact: true });
const open = (tab = page) => openBrowserTestPage(tab, `${server.resolvedUrls!.local[0]}single-keys-test`, box(tab));
const stored = () => page.evaluate(key => localStorage.getItem(key), SINGLE_KEYS_KEY);

test("single keys are on by default; unchecking stores off on this device and checking removes it", async () => {
  await open();
  await element(box()).toBeChecked();
  // The box is a switch, not a checkbox role: the account page promises that its main area holds no checkbox,
  // because consent there is read-only.
  await element(page.getByRole("main").getByRole("checkbox")).toHaveCount(0);
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

test("the box follows a change made in another tab on this device", async () => {
  await open();
  await open(otherTab);
  await element(box()).toBeChecked();
  await box(otherTab).uncheck();
  await element(box()).not.toBeChecked();
  await box(otherTab).check();
  await element(box()).toBeChecked();
}, 60_000);

test("the row's term and the statement beside the box sit on one line of text", async () => {
  await open();
  const top = async (text: string) => (await page.getByText(text, { exact: true }).boundingBox())!.y;
  expect(Math.abs(await top(t("account.field.shortcuts")) - await top(t("account.singleKeys")))).toBeLessThanOrEqual(1);
}, 60_000);
