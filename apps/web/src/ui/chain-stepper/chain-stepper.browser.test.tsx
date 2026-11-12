// SPDX-License-Identifier: LicenseRef-Proprietary
import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { firefox, expect as element } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { loadCatalog, t } from "@console/i18n";
import { browserTestOptimizeDeps, chromium, type Browser, type Page } from "../../lib/browser-test";

let server: ViteDevServer;
const browsers: Browser[] = [];
const pages: Page[] = [];
beforeAll(async () => {
  await loadCatalog("ko");
  server = await createServer({
    configFile: false, cacheDir: ".cache/chain-stepper-test", logLevel: "error",
    optimizeDeps: browserTestOptimizeDeps, resolve: { dedupe: ["react", "react-dom"] },
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, fs: { allow: [resolve("."), dirname(realpathSync("node_modules/pretendard"))] } },
    plugins: [{
      name: "chain-stepper-test",
      resolveId: id => id === "/chain-stepper-test.js" ? "\0chain-stepper-test" : undefined,
      load: id => id === "\0chain-stepper-test" ? `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { loadCatalog } from '@console/i18n';
        import '/apps/web/src/app.css';
        import '/apps/web/src/gallery/gallery.css';
        await loadCatalog('ko');
        const { default: Gallery } = await import('/apps/web/src/ui/chain-stepper/chain-stepper.gallery.tsx');
        createRoot(document.getElementById('root')).render(React.createElement(Gallery));
      ` : undefined,
    }],
  });
  await server.listen();
  for (const browserType of [chromium, firefox]) {
    const browser = await browserType.launch();
    browsers.push(browser);
    const page = await browser.newPage();
    pages.push(page);
    await page.route("**/chain-stepper-test", route => route.fulfill({ contentType: "text/html", body: '<html lang="ko"><title>Chain stepper</title><div id="root"></div><script type="module" src="/chain-stepper-test.js"></script></html>' }));
    await page.goto(`${server.resolvedUrls!.local[0]}chain-stepper-test`);
    await page.getByRole("list").nth(1).waitFor();
    await page.evaluate(async () => { await document.fonts.ready; });
  }
}, 60_000);
afterAll(async () => { await Promise.all(browsers.map(browser => browser.close())); await server?.close(); });

for (const [index, engine] of ["Chromium", "Firefox"].entries()) {
  test(`${engine}: a complete rejection note wraps within a narrow approval chain`, async () => {
    const page = pages[index]!;
    const chain = page.getByRole("list").nth(1);
    await element(chain).toContainText(t("orgChange.decide.reject.example"));
    for (const width of [1280, 390]) for (const theme of ["light", "dark"]) {
      await page.setViewportSize({ width, height: 844 });
      await page.locator("html").evaluate((el, theme) => { el.dataset.theme = theme; }, theme);
      expect(await chain.evaluate(el => ({
        page: document.scrollingElement!.scrollWidth - innerWidth,
        chain: el.scrollWidth - el.clientWidth,
        rows: Array.from(el.children, row => row.scrollWidth - row.clientWidth),
      })), `${width}px/${theme}`).toEqual({ page: 0, chain: 0, rows: [0, 0] });
    }
  });
}
