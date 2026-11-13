// SPDX-License-Identifier: LicenseRef-Proprietary
import { browserTestOptimizeDeps } from "../../../lib/browser-test";
import { resolve } from "node:path";
import { realpathSync } from "node:fs";
import { chromium, type Browser, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, expect, test } from "vitest";

let server: ViteDevServer;
let browser: Browser;
let page: Page;
beforeAll(async () => {
  server = await createServer({ configFile: false, cacheDir: ".cache/exit-settlement-test", logLevel: "error",
    optimizeDeps: browserTestOptimizeDeps,
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, fs: { allow: [resolve("."), realpathSync("node_modules/pretendard")] } },
    plugins: [{ name: "settlement-test", resolveId: id => id === "/settlement-test.js" ? "\0settlement-test" : undefined,
      load: id => id === "\0settlement-test" ? `
        import {createElement} from 'react'; import {createRoot} from 'react-dom/client';
        import {loadCatalog} from '@console/i18n';
        import Gallery from '/apps/web/src/features/people/ui/exit-settlement.gallery.tsx';
        import '/apps/web/src/app.css';
        await loadCatalog('ko'); createRoot(document.getElementById('root')).render(createElement(Gallery));
      ` : undefined,
      configureServer: vite => { vite.middlewares.use((req, res, next) => {
        if (req.url !== "/settlement-test") return next();
        res.setHeader("Content-Type", "text/html"); res.end('<div id="root"></div><script type="module" src="/settlement-test.js"></script>');
      }); },
    }],
  });
  await server.listen(); browser = await chromium.launch(); page = await browser.newPage();
  await page.goto(`${server.resolvedUrls!.local[0]}settlement-test`);
}, 60_000);
afterAll(async () => { await browser?.close(); await server?.close(); });

test("the exemption figure replaces wage amounts and retains the review hold", async () => {
  const figures = page.getByRole("region", { name: "산정 결과", exact: true });
  await figures.getByText("퇴직금 미해당 (근속 1년 미만)", { exact: true }).waitFor();
  expect(await figures.getByText("노무사 검토 전", { exact: false }).count()).toBe(1);
  expect(await figures.getByRole("group", { name: "평균임금 (1일)", exact: true }).count()).toBe(0);
  await figures.locator("summary").click();
  expect(await figures.getByText(/검증 법령 · 검증 조항/).isVisible()).toBe(true);
});
