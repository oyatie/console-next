// SPDX-License-Identifier: LicenseRef-Proprietary
import { resolve } from "node:path";
import { realpathSync } from "node:fs";
import { chromium, type Browser, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, expect, test } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import { browserTestOptimizeDeps } from "../../../lib/browser-test";
import { filingTask } from "../../../../../../e2e/mock/filings";

let server: ViteDevServer;
let browser: Browser;
let page: Page;
beforeAll(async () => {
  await loadCatalog("ko");
  server = await createServer({ configFile: false, cacheDir: ".cache/filing-window-test", logLevel: "error",
    optimizeDeps: browserTestOptimizeDeps,
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, fs: { allow: [resolve("."), realpathSync("node_modules/pretendard")] } },
    plugins: [{ name: "filing-window-test", resolveId: id => id === "/filing-window-test.js" ? "\0filing-window-test" : undefined,
      load: id => id === "\0filing-window-test" ? `
        import {createElement} from 'react'; import {createRoot} from 'react-dom/client'; import {flushSync} from 'react-dom';
        import {loadCatalog,t} from '@console/i18n';
        import {FilingWindow} from '/apps/web/src/features/statutory/ui/filing-deadline.tsx';
        import '/apps/web/src/app.css';
        await loadCatalog('ko');
        const root=createRoot(document.getElementById('root')),task=${JSON.stringify(filingTask)};
        window.showRule=(basis)=>flushSync(()=>root.render(createElement(FilingWindow,{task:{...task,basis:basis?task.basis:null}})));
        window.showRule(true);
      ` : undefined,
      configureServer: vite => { vite.middlewares.use((req, res, next) => {
        if (req.url !== "/filing-window-test") return next();
        res.setHeader("Content-Type", "text/html"); res.end('<div id="root"></div><script type="module" src="/filing-window-test.js"></script>');
      }); },
    }],
  });
  await server.listen(); browser = await chromium.launch(); page = await browser.newPage();
}, 60_000);
afterAll(async () => { await browser?.close(); await server?.close(); });

test.each([1440, 390])("a filing rule owns its review and keeps reachable targets at %i px", async width => {
  await page.setViewportSize({ width, height: 1000 });
  await page.goto(`${server.resolvedUrls!.local[0]}filing-window-test`);
  const summary = page.locator("summary");
  await summary.waitFor();
  expect(await page.getByText(t("statutory.hold"), { exact: true }).isVisible()).toBe(false);
  await summary.click();
  const citation = page.locator("cite");
  expect((await summary.boundingBox())!.height).toBeGreaterThanOrEqual(24);
  expect(await citation.isVisible()).toBe(true);
  expect(await page.getByRole("link").count()).toBe(0);
  await page.evaluate(() => (window as unknown as { showRule: (basis: boolean) => void }).showRule(false));
  expect(await page.locator("summary").count()).toBe(0);
  expect(await page.getByText(t("statutory.hold"), { exact: true }).isVisible()).toBe(true);
  expect(await page.evaluate(() => document.scrollingElement!.scrollWidth <= innerWidth)).toBe(true);
});
