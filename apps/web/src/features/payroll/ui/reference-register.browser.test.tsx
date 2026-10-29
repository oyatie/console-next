// SPDX-License-Identifier: LicenseRef-Proprietary
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { expect as dom } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, expect, test } from "vitest";
import { rate } from "../../../../../../e2e/mock/payroll";
import { browserTestOptimizeDeps, chromium, type Browser, type Page } from "../../../lib/browser-test";

let server: ViteDevServer;
let browser: Browser;
let page: Page;
const errors: string[] = [];
beforeAll(async () => {
  server = await createServer({ configFile: false, cacheDir: ".cache/payroll-browser-test", logLevel: "error", define: { "process.env.VIRT_ON": "true" }, optimizeDeps: browserTestOptimizeDeps,
    resolve: { dedupe: ["react", "react-dom"] },
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, fs: { allow: [resolve("."), realpathSync("node_modules/pretendard")] } },
    plugins: [{ name: "payroll-register-test", resolveId: id => id === "/payroll-test.js" ? "\0payroll-test" : undefined,
      load: id => id === "\0payroll-test" ? `
        import React from 'react'; import {createRoot} from 'react-dom/client';
        import {loadCatalog} from '@console/i18n';
        import {ReferenceRegister} from '/apps/web/src/features/payroll/ui/reference-register.tsx';
        import '/apps/web/src/app.css';
        await loadCatalog('ko');
        const rate=${JSON.stringify(rate)}; const root=createRoot(document.getElementById('root'));
        window.draw=(mode)=>root.render(React.createElement(ReferenceRegister,{data:{adopted:mode!=='unsupported',country_code:'US',items:[{...rate,instrument_ko:mode==='held'?'':rate.instrument_ko}]}}));
        window.draw('held');
      ` : undefined,
      configureServer: vite => { vite.middlewares.use((req, res, next) => {
        if (req.url !== "/") return next();
        res.setHeader("content-type", "text/html"); res.end('<html><body><div id="root"></div><script type="module" src="/payroll-test.js"></script></body></html>');
      }); },
    }],
  });
  await server.listen();
  browser = await chromium.launch();
  page = await browser.newPage();
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(server.resolvedUrls!.local[0]!);
}, 60_000);
afterAll(async () => { await browser?.close(); await server?.close(); });

test("register hides uncited and unadopted figures in the browser", async () => {
    await dom(page.getByText("근거 확인 필요", { exact: true }).first()).toBeVisible();
    await dom(page.getByText("0.123456%", { exact: true })).toHaveCount(0);
    await page.evaluate(() => (window as unknown as { draw: (mode: string) => void }).draw("cited"));
    await dom(page.getByText("0.123456%", { exact: true })).toBeVisible();
    await dom(page.getByRole("link")).toHaveAttribute("href", "https://example.com/payroll-source");
    await page.evaluate(() => (window as unknown as { draw: (mode: string) => void }).draw("unsupported"));
    await dom(page.getByText("기준표 없음", { exact: true })).toBeVisible();
    await dom(page.getByText("0.123456%", { exact: true })).toHaveCount(0);
    await dom(page.getByRole("link")).toHaveCount(0);
    expect(errors).toEqual([]);
});
