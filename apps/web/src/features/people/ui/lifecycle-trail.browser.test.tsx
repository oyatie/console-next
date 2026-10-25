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
  server = await createServer({ configFile: false, cacheDir: ".cache/trail-test", logLevel: "error",
    optimizeDeps: browserTestOptimizeDeps,
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, fs: { allow: [resolve("."), realpathSync("node_modules/pretendard")] } },
    plugins: [{ name: "trail-test", resolveId: (id) => id === "/trail-test.js" ? "\0trail-test" : undefined,
      load: (id) => id === "\0trail-test" ? `
        import {createElement} from 'react'; import {createRoot} from 'react-dom/client'; import {flushSync} from 'react-dom';
        import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
        import {createMemoryHistory,createRootRoute,createRouter,RouterContextProvider} from '@tanstack/react-router';
        import {loadCatalog} from '@console/i18n';
        import {TrailItems} from '/apps/web/src/features/people/ui/lifecycle-trail.tsx';
        import '/apps/web/src/app.css';
        await loadCatalog('ko');
        const root=createRoot(document.getElementById('root')),client=new QueryClient();
        const router=createRouter({routeTree:createRootRoute(),history:createMemoryHistory({initialEntries:['/']})});
        window.showTrail=(cancelled)=>flushSync(()=>root.render(createElement(QueryClientProvider,{client},
          createElement(RouterContextProvider,{router},createElement(TrailItems,{onRecord:()=>{},value:{
            id:'case',employee_id:'person',kind:'EXIT',state:cancelled?'CANCELLED':'OPEN',effective_date:'2026-10-25',
            cancellation_reason:cancelled?'계약 연장 합의':null,items:[{id:'doc',kind:'DOC',label:'검증 서류',
            status:cancelled?'CANCELLED':'OPEN',basis:{},record_target:'contract',filing_obligation_id:'filing'}]}})))));
        window.showTrail(false);
        window.showEvidence=(recorded,name)=>flushSync(()=>root.render(createElement(QueryClientProvider,{client},
          createElement(RouterContextProvider,{router},createElement(TrailItems,{onRecord:()=>{},value:{
            id:'evidence-case',employee_id:'person',kind:'HIRE',state:'OPEN',effective_date:'2026-10-25',items:[
              {id:'evidence',kind:'DOC',label:'검증 서류',status:recorded?'DONE_ATTESTED':'OPEN',basis:{},owner_line:'hr.personal:manage',completion_rule_ref:'LIFECYCLE_ITEM_ATTESTED',
                observed_ref:recorded?{document:{name,url:'https://evidence.example/document.pdf'}}:null},
              {id:'next',kind:'REC',label:'후속 기록',status:'OPEN',basis:{},record_target:'birth_date'},
            ]}})))));
      ` : undefined,
      configureServer: (vite) => { vite.middlewares.use((req, res, next) => {
        if (req.url !== "/trail-test") return next();
        res.setHeader("Content-Type", "text/html"); res.end('<div id="root"></div><script type="module" src="/trail-test.js"></script>');
      }); },
    }],
  });
  await server.listen(); browser = await chromium.launch(); page = await browser.newPage();
  await page.goto(`${server.resolvedUrls!.local[0]}trail-test`);
  await page.getByRole("button", { name: "검증 서류" }).waitFor();
}, 60_000);
afterAll(async () => { await browser?.close(); await server?.close(); });
test("a live cancellation keeps the paperwork group in place and retains its rows and reason", async () => {
  const group = page.getByRole("region", { name: "서류 · 기록" });
  const before = (await group.boundingBox())!;
  await page.evaluate(() => (window as unknown as { showTrail: (cancelled: boolean) => void }).showTrail(true));
  const after = (await group.boundingBox())!;
  expect(after.height).toBeGreaterThanOrEqual(before.height);
  expect(after.y).toBe(before.y);
  expect(await group.textContent()).toContain("취소");
  expect(await page.getByText("계약 연장 합의").isVisible()).toBe(true);
  expect(await group.getByText("검증 서류", { exact: true }).count()).toBe(1);
});

test.each([1440, 390].flatMap((width) => ["서명한 입사 계약서", "서명한 입사 계약서 ".repeat(20)].map((name) => ({ width, name }))))("a document receipt preserves the next record control at $width px ($name)", async ({ width, name }) => {
  await page.setViewportSize({ width, height: 1000 });
  const show = (recorded: boolean) => page.evaluate((value) => (window as unknown as { showEvidence: (recorded: boolean, name: string) => void }).showEvidence(value.recorded, value.name), { recorded, name });
  await show(false);
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  const next = page.locator("#item-next").getByRole("button");
  const before = (await next.boundingBox())!;
  await show(true);
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  expect(await page.getByRole("link", { name, exact: true }).count()).toBe(1);
  expect((await next.boundingBox())!.y).toBe(before.y);
});
