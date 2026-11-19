// SPDX-License-Identifier: LicenseRef-Proprietary
import { realpathSync } from "node:fs";
import { afterAll, beforeAll, expect, test } from "vitest";
import { expect as element } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { i18n, loadCatalog, t } from "@console/i18n";
import { browserTestOptimizeDeps, chromium, openBrowserTestPage, type Browser, type Page } from "../../../lib/browser-test";
import { SINGLE_KEYS_KEY } from "../../../lib/prefs";

const [fixture] = Object.values(import.meta.glob<string>("./people-jump.browser-fixture.tsx", { query: "?url", import: "default", eager: true }));
let server: ViteDevServer;
let browser: Browser;
let page: Page;
beforeAll(async () => {
  await loadCatalog("en");
  i18n.set("en");
  server = await createServer({ configFile: false, cacheDir: ".cache/people-jump-test", logLevel: "error",
    optimizeDeps: { ...browserTestOptimizeDeps, entries: ["apps/web/src/features/people/ui/people-jump.browser-fixture.tsx"] },
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, fs: { allow: [process.cwd(), realpathSync("node_modules/pretendard")] } },
  });
  await server.listen();
  browser = await chromium.launch();
  page = await browser.newPage();
  await page.route("**/people-jump-test", route => route.fulfill({ contentType: "text/html", body: `<html lang="en"><title>People keys</title><div id="root"></div><script type="module" src="${fixture}"></script></html>` }));
}, 120_000);
afterAll(async () => { i18n.set("ko"); await browser?.close(); await server?.close(); });

test("with single keys off ? waits and ⌘/ still opens the people key map, which lists that chord and says single keys are off", async () => {
  const map = page.getByRole("dialog", { name: t("peopleJump.keys"), exact: true });
  const off = map.getByText(t("account.singleKeys.off"), { exact: true });
  await openBrowserTestPage(page, `${server.resolvedUrls!.local[0]}people-jump-test`, page.getByText(t("people.title"), { exact: true }));

  await page.keyboard.press("Shift+Slash");
  await element(map).toBeVisible();
  await element(map.getByText("⌘/", { exact: true })).toBeVisible();
  await element(off).toHaveCount(0);
  await page.keyboard.press("Escape");
  await element(map).toHaveCount(0);

  // Read at each key and each draw: no reload.
  await page.evaluate(key => localStorage.setItem(key, "off"), SINGLE_KEYS_KEY);
  await page.keyboard.press("Shift+Slash");
  await element(map).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+Slash");
  await element(off).toBeVisible();
  // The line is longer than the hint it replaces: it wraps inside the panel's head, and the Esc chip beside it
  // keeps its label inside its border.
  const [panel, line] = [(await map.boundingBox())!, (await off.boundingBox())!];
  expect(line.x).toBeGreaterThanOrEqual(panel.x);
  expect(line.x + line.width).toBeLessThanOrEqual(panel.x + panel.width);
  expect(await map.locator("kbd", { hasText: "Esc" }).first().evaluate(chip => chip.scrollWidth <= chip.clientWidth)).toBe(true);
}, 60_000);
