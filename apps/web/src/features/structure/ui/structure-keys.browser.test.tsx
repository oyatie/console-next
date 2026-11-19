// SPDX-License-Identifier: LicenseRef-Proprietary
import { afterAll, beforeAll, test } from "vitest";
import { expect as element } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { i18n, loadCatalog, t } from "@console/i18n";
import { browserTestOptimizeDeps, chromium, openBrowserTestPage, type Browser, type Page } from "../../../lib/browser-test";
import { SINGLE_KEYS_KEY } from "../../../lib/prefs";

const [fixture] = Object.values(import.meta.glob<string>("./structure-keys.browser-fixture.tsx", { query: "?url", import: "default", eager: true }));
let server: ViteDevServer;
let browser: Browser;
let page: Page;
beforeAll(async () => {
  await loadCatalog("en");
  i18n.set("en");
  server = await createServer({ configFile: false, cacheDir: ".cache/structure-keys-test", logLevel: "error",
    optimizeDeps: { ...browserTestOptimizeDeps, entries: ["apps/web/src/features/structure/ui/structure-keys.browser-fixture.tsx"] },
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, fs: { allow: [process.cwd()] } },
  });
  await server.listen();
  browser = await chromium.launch();
  page = await browser.newPage();
  await page.route("**/structure-keys-test", route => route.fulfill({ contentType: "text/html", body: `<html lang="en"><title>Structure keys</title><div id="root"></div><script type="module" src="${fixture}"></script></html>` }));
}, 120_000);
afterAll(async () => { i18n.set("ko"); await browser?.close(); await server?.close(); });

test("with single keys off ? waits, the help button stops announcing it, and the key map it opens says so", async () => {
  const help = page.getByRole("button", { name: t("structure.shortcuts.title"), exact: true });
  const map = page.getByRole("dialog", { name: t("structure.shortcuts.title"), exact: true });
  const off = map.getByText(t("account.singleKeys.off"), { exact: true });
  const open = () => openBrowserTestPage(page, `${server.resolvedUrls!.local[0]}structure-keys-test`, help);

  await open();
  await element(help).toHaveAttribute("aria-keyshortcuts", "Shift+/");
  await page.keyboard.press("Shift+Slash");
  await element(map).toBeVisible();
  await element(off).toHaveCount(0);

  await page.evaluate(key => localStorage.setItem(key, "off"), SINGLE_KEYS_KEY);
  await open();
  await element(help).not.toHaveAttribute("aria-keyshortcuts");
  await page.keyboard.press("Shift+Slash");
  await element(map).toHaveCount(0);
  await help.click();
  await element(off).toBeVisible();
}, 60_000);
