// SPDX-License-Identifier: LicenseRef-Proprietary
import { afterAll, beforeAll, test } from "vitest";
import { expect as element } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { browserTestOptimizeDeps, chromium, openBrowserTestPage, type Browser, type Page } from "../../lib/browser-test";
import { SINGLE_KEYS_KEY } from "../../lib/prefs";

const [fixture] = Object.values(import.meta.glob<string>("./action-grid.browser-fixture.tsx", { query: "?url", import: "default", eager: true }));
let server: ViteDevServer;
let browser: Browser;
let page: Page;
beforeAll(async () => {
  server = await createServer({ configFile: false, cacheDir: ".cache/action-grid-test", logLevel: "error",
    optimizeDeps: { ...browserTestOptimizeDeps, entries: ["apps/web/src/ui/action-grid/action-grid.browser-fixture.tsx"] },
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, fs: { allow: [process.cwd()] } },
  });
  await server.listen();
  browser = await chromium.launch();
  page = await browser.newPage();
  await page.route("**/action-grid-test", route => route.fulfill({ contentType: "text/html", body: `<html lang="en"><title>Action grid</title><div id="root"></div><script type="module" src="${fixture}"></script></html>` }));
}, 120_000);
afterAll(async () => { await browser?.close(); await server?.close(); });

test("with single keys off the grid's letters wait and show no hint while ⌘X, Enter and Escape still act; back on, a letter picks with no reload", async () => {
  const grid = page.getByRole("dialog", { name: "Acts" });
  const picked = page.getByRole("status", { name: "Picked" });
  const hints = grid.locator("kbd");
  const open = () => openBrowserTestPage(page, `${server.resolvedUrls!.local[0]}action-grid-test`, grid);
  await open();
  await element(hints).toHaveText(["M", "⌘X"]);
  await page.evaluate(key => localStorage.setItem(key, "off"), SINGLE_KEYS_KEY);
  // The grid reads the setting when it draws: a letter that waits has no hint, the chord keeps its own.
  await open();
  await element(hints).toHaveText(["⌘X"]);
  // The letters are pressed first: had one picked, its act would stand before the chord's.
  await page.keyboard.press("m");
  await page.keyboard.press("Shift+M");
  await page.keyboard.press("Meta+x");
  await element(picked).toHaveText("exit");
  // The grid focuses its first act when it opens; Enter on it is a press of that button.
  await page.keyboard.press("Enter");
  await element(picked).toHaveText("exit move");

  await page.evaluate(key => localStorage.removeItem(key), SINGLE_KEYS_KEY);
  await page.keyboard.press("m");
  await element(picked).toHaveText("exit move move");
  await element(hints).toHaveText(["M", "⌘X"]);

  await page.evaluate(key => localStorage.setItem(key, "off"), SINGLE_KEYS_KEY);
  await page.keyboard.press("Escape");
  await element(grid).toHaveCount(0);
}, 60_000);
