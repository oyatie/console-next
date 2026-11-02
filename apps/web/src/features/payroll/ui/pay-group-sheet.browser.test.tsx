// SPDX-License-Identifier: LicenseRef-Proprietary
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { expect as dom } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, expect, test } from "vitest";
import { browserTestOptimizeDeps, chromium, type Browser, type Page } from "../../../lib/browser-test";

let server: ViteDevServer;
let browser: Browser;
let page: Page;
const errors: string[] = [];
beforeAll(async () => {
  server = await createServer({ configFile: false, cacheDir: ".cache/pay-group-browser-test", logLevel: "error", optimizeDeps: browserTestOptimizeDeps,
    resolve: { dedupe: ["react", "react-dom"] },
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, fs: { allow: [resolve("."), realpathSync("node_modules/pretendard")] } },
    plugins: [{ name: "pay-group-test", resolveId: id => id === "/setup-test.js" ? "\0setup-test" : undefined,
      load: id => id === "\0setup-test" ? `
        import React from 'react'; import {createRoot} from 'react-dom/client';
        import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
        import {loadCatalog} from '@console/i18n';
        import {PayGroupSheet} from '/apps/web/src/features/payroll/ui/pay-group-sheet.tsx';
        import '/apps/web/src/app.css';
        await loadCatalog('ko');
        createRoot(document.getElementById('root')).render(React.createElement(QueryClientProvider,{client:new QueryClient()},React.createElement(PayGroupSheet,{entities:[{id:'synthetic',name:'모의상사'}],onClose:()=>{},onSaved:()=>{}})));
      ` : undefined,
      configureServer: vite => { vite.middlewares.use((req, res, next) => {
        if (req.url !== "/") return next();
        res.setHeader("content-type", "text/html"); res.end('<html lang="ko"><body><div id="root"></div><script type="module" src="/setup-test.js"></script></body></html>');
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

test("the sheet starts blank and required fields explain an incomplete submission", async () => {
  const sheet = page.getByRole("dialog", { name: "급여 그룹 추가", exact: true });
  await dom(sheet).toBeVisible();
  for (const control of await sheet.getByRole("combobox").all()) await dom(control).toHaveValue("");
  await dom(sheet.getByRole("checkbox", { checked: true })).toHaveCount(0);
  await sheet.getByRole("button", { name: "급여 그룹 저장", exact: true }).click();
  await dom(sheet.getByRole("alert")).toBeVisible();
  await dom(sheet.getByLabel("그룹 이름", { exact: false })).toHaveValue("");
  expect(errors).toEqual([]);
});
