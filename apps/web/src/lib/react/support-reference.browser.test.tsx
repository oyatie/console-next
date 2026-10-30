// SPDX-License-Identifier: LicenseRef-Proprietary
import { browserTestOptimizeDeps } from "../browser-test";
import { dirname, resolve } from "node:path";
import { realpathSync } from "node:fs";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createServer, searchForWorkspaceRoot, type ViteDevServer } from "vite";
import { chromium, type Browser, type Page } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";

let server: ViteDevServer;
let browser: Browser;
let lookupPage: Page;
let statesPage: Page;
let fallbackPage: Page;
const reference = "0123456789abcdef0123456789abcdef";
const receipt = { support_ref: reference, support_ref_at: "2026-10-22T04:50:18.769Z" };
beforeAll(async () => {
  server = await createServer({
    configFile: false, appType: "custom", cacheDir: ".cache/vite-support-reference-test",
    // The fixture module is virtual, so the scanner misses its deps; a late second optimize pass reloads the page mid-test on a cold cache.
    optimizeDeps: browserTestOptimizeDeps,
    resolve: { alias: { "@console/api": resolve("packages/api/src"), "@console/i18n": resolve("packages/i18n/src") }, dedupe: ["react", "react-dom"] },
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, fs: { allow: [searchForWorkspaceRoot(process.cwd()), dirname(realpathSync(resolve("node_modules/pretendard")))] } },
    plugins: [{
      name: "support-reference-test",
      configureServer(s) {
        s.middlewares.use((req, res, next) => {
          if (req.url === "/support-reference-static-fixture") {
            res.setHeader("Content-Type", "text/html; charset=utf-8");
            return res.end('<!doctype html><html lang="ko"><head><title>Support reference</title><link rel="stylesheet" href="/apps/web/src/app.css"></head><body><div id="root"></div></body></html>');
          }
          if (req.url !== "/support-reference-fixture") return next();
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.end('<!doctype html><html lang="ko"><head><title>Support reference</title></head><body><div id="root"></div><script type="module" src="/__support-reference-test.tsx"></script></body></html>');
        });
      },
      resolveId: id => id === "/__support-reference-test.tsx" ? id : undefined,
      load: id => id === "/__support-reference-test.tsx" ? `import "/apps/web/src/app.css";

      import React from "react";
      import { createRoot } from "react-dom/client";
      import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
      import { createRouter, createRootRoute, RouterProvider, createMemoryHistory } from '@tanstack/react-router';
      import { ApiError, configure } from '@console/api';
      import { loadCatalog } from '@console/i18n';
      import { QueryState } from '/apps/web/src/lib/react/query-state.tsx';
      import { Denied } from '/apps/web/src/lib/react/denied.tsx';
      import { CommandError } from '/apps/web/src/lib/react/command-error.tsx';
      import { SupportLookup } from '/apps/web/src/lib/react/support-lookup.tsx';
      await loadCatalog('ko');
      configure({baseUrl:location.origin,refresh:{kind:'cookie'},passkeys:{get:async()=>null,create:async()=>null}});
      const error = status => ApiError.fromBody(new Response(null, { status }), {error:{code:'internal',message:'internal server error',...${JSON.stringify(receipt)}}});
      const h = React.createElement;
      const q = {isPending:false,error:error(500),data:undefined,refetch:()=>{}};
      const Case = (name, child) => h('section',{'data-case':name},child);
      const route = createRootRoute({component:()=>h('main', null,
        h('h1',null,'Reference states'),
        Case('load',h(QueryState,{q},()=>null)),
        Case('background',h(QueryState,{q:{...q,data:'saved'}},value=>h('div',null,value))),
        Case('denied',h(Denied,{error:error(403)})),
        Case('mutation',h(CommandError,{error:error(500)})),
        Case('lookup',h(SupportLookup)))});
      const router = createRouter({routeTree:route,history:createMemoryHistory({initialEntries:['/']})});
      createRoot(document.getElementById('root')).render(h(QueryClientProvider,{client:new QueryClient({defaultOptions:{queries:{enabled:false,retry:false}}})},h(RouterProvider,{router})));
` : undefined,
    }],
  });
  await server.listen();
  browser = await chromium.launch();
  lookupPage = await (await browser.newContext()).newPage();
  statesPage = await (await browser.newContext()).newPage();
  fallbackPage = await (await browser.newContext()).newPage();
  for (const page of [lookupPage, statesPage]) {
    await page.goto(`${server.resolvedUrls!.local[0]}support-reference-fixture`);
    await page.locator("[data-support-reference]").first().waitFor();
  }
  await fallbackPage.goto(`${server.resolvedUrls!.local[0]}support-reference-static-fixture`);
}, 60_000);
afterAll(async () => { await browser?.close(); await server?.close(); });

test("Enter submits the displayed short reference once and ignores IME composition", async () => {
  const page = lookupPage;
  const lookups: string[] = [];
  await page.route("**/api/v1/support-references/*", route => {
    lookups.push(new URL(route.request().url()).pathname);
    return route.fulfill({ json: { ...receipt, trace_id: reference, release: "previous-deploy", route_template: "/people/:id" } });
  });
  await page.goto(`${server.resolvedUrls!.local[0]}support-reference-fixture`);
  await page.getByText("지원 참조 번호 조회", { exact: true }).click();
  const input = page.getByLabel("전체 지원 참조 번호");
  await input.fill(`ref ${reference.slice(0, 8)}`);
  await input.dispatchEvent("keydown", { key: "Enter", isComposing: true });
  await input.dispatchEvent("keydown", { key: "Enter", keyCode: 229 });
  expect(lookups).toEqual([]);
  await input.press("Enter");
  await page.getByText("previous-deploy", { exact: true }).waitFor({ timeout: 2000 });
  expect(lookups).toEqual([`/api/v1/support-references/${reference.slice(0, 8)}`]);
}, 30_000);

test("shared load, background, denied and mutation rows copy full ids and pass axe at desktop and phone widths", async () => {
  const page = statesPage;
  await page.goto(`${server.resolvedUrls!.local[0]}support-reference-fixture`);
  await page.locator("[data-support-reference]").first().waitFor();
  for (const name of ["load", "background", "denied", "mutation"]) {
    const state = page.locator(`[data-case="${name}"]`);
    expect(await state.locator("[data-support-reference]").count()).toBe(1);
    expect(await state.locator("[data-support-reference] code").textContent()).toBe(reference.slice(0, 8));
    expect(await state.locator("time").textContent()).toBe("2026. 10. 22. 13:50 KST");
  }
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1200 });
    for (const theme of ["light", "dark"]) {
      await page.locator("html").evaluate((el, value) => el.dataset.theme = value, theme);
      const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
      expect(violations.filter(v => ["serious", "critical"].includes(v.impact ?? ""))).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
  }
  await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { (window as Window & { copied?: string }).copied = text; } } }));
  await page.locator('[data-case="load"]').getByRole("button", { name: "지원 참조 번호 복사" }).click();
  expect(await page.evaluate(() => (window as Window & { copied?: string }).copied)).toBe(`ref ${reference}`);
  await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined }));
  await page.locator('[data-case="load"]').getByRole("button", { name: "지원 참조 번호 복사" }).click();
  await page.getByText(reference, { exact: true }).waitFor();
}, 30_000);


test("the unbundled fallback separates reference and timestamp and keeps reload compact", async () => {
  const page = fallbackPage;
  await page.goto(`${server.resolvedUrls!.local[0]}support-reference-static-fixture`);
  await page.evaluate(data => Object.assign(window, { consoleErrorBeacon: { reference: () => Promise.resolve(data) } }), receipt);
  await page.addScriptTag({ url: `${server.resolvedUrls!.local[0]}apps/web/public/chunk-guard.js` });
  await page.evaluate(() => (window as unknown as { consoleChunkGuard: { fail(): void } }).consoleChunkGuard.fail());
  await page.locator("[data-support-reference]").waitFor();
  expect(await page.locator("[data-support-reference]").textContent()).toContain(" · 2026-10-22 04:50:18 UTC · ");
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 844 });
    const bounds = await page.getByRole("button", { name: "페이지 새로 고침" }).boundingBox();
    expect(bounds!.height).toBeLessThan(50);
    for (const theme of ["light", "dark"]) {
      await page.locator("html").evaluate((el, value) => el.dataset.theme = value, theme);
      const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
      expect(violations.filter(v => ["serious", "critical"].includes(v.impact ?? ""))).toEqual([]);
    }
  }
}, 30_000);
