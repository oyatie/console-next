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
beforeAll(async () => {
  server = await createServer({ configFile: false, cacheDir: ".cache/inline-field-test", logLevel: "error",
    optimizeDeps: browserTestOptimizeDeps,
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, fs: { allow: [resolve("."), realpathSync("node_modules/pretendard")] } },
    plugins: [{ name: "inline-field-test", resolveId: id => id === "/inline-test.js" ? "\0inline-test" : undefined,
      load: id => id === "\0inline-test" ? `
        import React from 'react'; import {createRoot} from 'react-dom/client';
        import {loadCatalog,t} from '@console/i18n';
        import {InlineField} from '/apps/web/src/features/people/ui/inline-field.tsx';
        import '/apps/web/src/app.css';
        await loadCatalog('ko');
        window.saved=[];
        function Fixture(){
          const [sending,setSending]=React.useState();
          return React.createElement(React.Fragment,null,
            React.createElement(InlineField,{label:t('empCard.f.nameAlt'),raw:'Taylor',manage:true,sending,
              onSave:next=>{window.saved.push(next);setSending(next);}},'Taylor'),
            React.createElement('button',null,t('common.cancel')));
        }
        createRoot(document.getElementById('root')).render(React.createElement(Fixture));
      ` : undefined,
      configureServer: vite => { vite.middlewares.use((req, res, next) => {
        if (req.url !== "/") return next();
        res.setHeader("content-type", "text/html"); res.end('<html><body><div id="root"></div><script type="module" src="/inline-test.js"></script></body></html>');
      }); },
    }],
  });
  await server.listen();
  browser = await chromium.launch();
  page = await browser.newPage();
  await page.goto(server.resolvedUrls!.local[0]!);
}, 60_000);
afterAll(async () => { await browser?.close(); await server?.close(); });

test("text quick edits retain keyboard cancellation, blur and saving feedback", async () => {
  const edit = page.getByRole("button", { name: "성명 한자 · 영문 수정", exact: true });
  const input = page.getByRole("textbox");
  await edit.focus();
  await edit.press("Enter");
  await dom(input).toBeFocused();
  await input.fill("Discard");
  await input.press("Escape");
  await dom(input).toHaveCount(0);
  await dom(edit).toBeFocused();
  await edit.press("Enter");
  const outside = page.getByRole("button", { name: "취소", exact: true });
  await outside.click();
  await dom(input).toHaveCount(0);
  await dom(outside).toBeFocused();
  expect(await page.evaluate(() => (window as unknown as { saved: string[] }).saved)).toEqual([]);
  await edit.click();
  await input.fill("  Morgan  ");
  await input.press("Enter");
  await dom(edit).toBeFocused();
  await dom(page.getByRole("img", { name: "저장 중", exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { saved: string[] }).saved)).toEqual(["Morgan"]);
});
