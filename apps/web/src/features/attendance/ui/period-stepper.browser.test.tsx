// SPDX-License-Identifier: LicenseRef-Proprietary
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, test } from "vitest";
import { expect as expectElement } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { browserTestOptimizeDeps, chromium, type Browser, type Page } from "../../../lib/browser-test";

let server: ViteDevServer;
let browser: Browser;
let pages: Page[];
beforeAll(async () => {
  server = await createServer({
    configFile: false, cacheDir: ".cache/period-stepper-test", logLevel: "error", optimizeDeps: browserTestOptimizeDeps,
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, fs: { allow: [resolve("."), realpathSync("node_modules/pretendard")] } },
    plugins: [{
      name: "period-stepper-test",
      resolveId: id => id === "/period-test.js" ? "\0period-test" : undefined,
      load: id => id === "\0period-test" ? `
        import {createElement as h} from 'react'; import {createRoot} from 'react-dom/client';
        import {loadCatalog} from '@console/i18n';
        import Demo from '/apps/web/src/features/attendance/ui/period-stepper.gallery.tsx';
        import '/apps/web/src/app.css';
        await loadCatalog('ko');
        createRoot(document.getElementById('root')).render(h(Demo));
      ` : undefined,
      configureServer: vite => { vite.middlewares.use((req, res, next) => {
        if (req.url !== "/period-test") return next();
        res.setHeader("Content-Type", "text/html");
        res.end('<html lang="ko"><title>Period</title><div id="root"></div><script type="module" src="/period-test.js"></script></html>');
      }); },
    }],
  });
  await server.listen();
  browser = await chromium.launch();
  pages = await Promise.all([0, 1, 2, 3].map(() => browser.newPage({ viewport: { width: 390, height: 900 } })));
}, 60_000);
afterAll(async () => { await browser?.close(); await server?.close(); });

for (const [index, unit] of ["day", "week", "month", "year"].entries()) {
  test(`${unit} arrows and current-period jump update a controlled value by keyboard`, async () => {
    const page = pages[index]!;
    try {
      await page.goto(`${server.resolvedUrls!.local[0]}period-test`);
      const period = page.getByRole("group", { name: "기간 이동", exact: true }).nth(index);
      const text = period.locator("strong"), buttons = period.getByRole("button");
      await expectElement(text).toBeVisible();
      const current = await text.innerText();
      await buttons.nth(0).focus();
      await page.keyboard.press("Enter");
      await expectElement(text).not.toHaveText(current);
      await buttons.nth(1).focus();
      await page.keyboard.press("Space");
      await expectElement(text).toHaveText(current);
      await buttons.nth(0).click();
      await expectElement(text).not.toHaveText(current);
      await buttons.nth(2).click();
      await expectElement(text).toHaveText(current);
    } finally { await page.close(); }
  });
}
