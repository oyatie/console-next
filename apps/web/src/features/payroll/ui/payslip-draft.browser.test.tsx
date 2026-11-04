// SPDX-License-Identifier: LicenseRef-Proprietary
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { expect as dom } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, expect, test } from "vitest";
import { loadCatalog } from "@console/i18n";
import { commitLabel } from "../../../ui/composer/actions";
import { screenAccess } from "../../../../../../e2e/mock/fixtures";
import { draft } from "../../../../../../e2e/mock/employee-pay";
import { browserTestOptimizeDeps, chromium, type Browser, type Page } from "../../../lib/browser-test";

let server: ViteDevServer;
let browser: Browser;
let page: Page;
const errors: string[] = [];
beforeAll(async () => {
  await loadCatalog("ko");
  server = await createServer({ configFile: false, cacheDir: ".cache/employee-pay-browser-test", logLevel: "error", define: { "process.env.VIRT_ON": "true" }, optimizeDeps: browserTestOptimizeDeps,
    resolve: { dedupe: ["react", "react-dom"] },
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, fs: { allow: [resolve("."), realpathSync("node_modules/pretendard")] } },
    plugins: [{ name: "payroll-register-test", resolveId: id => id === "/payroll-test.js" ? "\0payroll-test" : undefined,
      load: id => id === "\0payroll-test" ? `
        import React from 'react'; import {createRoot} from 'react-dom/client';
        import {loadCatalog} from '@console/i18n';
        import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
        import {createRouter,createRootRoute,createRoute,createMemoryHistory,RouterProvider,Outlet} from '@tanstack/react-router';
        import {EmployeePayLink} from '/apps/web/src/reference/payroll/ui/employee-pay-link.tsx';
        import {operationAccess} from '/apps/web/src/reference/authz/domain/operation-access.ts';
        import {ContractWageForm} from '/apps/web/src/features/payroll/ui/contract-wage-form.tsx';
        import {PayslipDraftView} from '/apps/web/src/features/payroll/ui/payslip-draft.tsx';
        import '/apps/web/src/app.css';
        await loadCatalog('ko');
        const draft=${JSON.stringify(draft)}; const root=createRoot(document.getElementById('root'));
        window.draw=(mode)=>root.render(React.createElement(PayslipDraftView,{data:{...draft,issuable:true,contract:mode==='no-source'?{...draft.contract,source_note:''}:draft.contract,deductions:draft.deductions.map(row=>({...row,blocked_by:mode==='blocked'?'unresolved':null,instrument:{...row.instrument,url:mode==='held'?'':row.instrument.url}}))}}));
        window.drawLink=async(allowed,ready)=>{
          const client=new QueryClient({defaultOptions:{queries:{staleTime:Infinity}}});
          window.linkSettled=()=>client.getQueryCache().getAll().length===2&&client.getQueryCache().getAll().every(q=>q.state.status==='success');
          const base=createRootRoute({component:Outlet});
          const home=createRoute({getParentRoute:()=>base,path:'/',component:()=>React.createElement(QueryClientProvider,{client},React.createElement(EmployeePayLink,{employeeId:'synthetic'}))});
          const record=createRoute({getParentRoute:()=>base,path:'/payroll/employees/$employeeId',staticData:{access:operationAccess['GET /api/v1/payroll/employees/{employeeId}/payslip-draft']}});
          const router=createRouter({routeTree:base.addChildren([home,record]),history:createMemoryHistory({initialEntries:['/']})});
          await router.load();
          root.render(React.createElement('div',{'data-link-state':String(allowed)+String(ready)},React.createElement(RouterProvider,{router,key:String(allowed)+String(ready)})));
        };
        window.drawForm=()=>root.render(React.createElement(QueryClientProvider,{client:new QueryClient()},React.createElement(ContractWageForm,{employeeId:'synthetic',onClose:()=>{}})));
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

test("draft never claims completeness and only shows sourced, settled amounts", async () => {
  await dom(page.getByText("미완성 초안", { exact: true })).toBeVisible();
  await dom(page.getByText("원천징수 미계산", { exact: true })).toHaveCount(1);
  await dom(page.getByText("34,567원", { exact: true })).toHaveCount(0);
  for (const mode of ["cited", "blocked", "no-source"]) {
    await page.evaluate(mode => (window as unknown as { draw: (mode: string) => void }).draw(mode), mode);
    await dom(page.getByText("34,567원", { exact: true })).toHaveCount(mode === "blocked" ? 0 : 1);
    await dom(page.getByText("3,456,789원", { exact: true })).toHaveCount(mode === "no-source" ? 0 : 1);
    await dom(page.getByText("확인 불가 · 원천징수 미계산", { exact: true })).toBeVisible();
  }
  expect(errors).toEqual([]);
});

test("the personnel link requires generated payroll access and module readiness", async () => {
  for (const [allowed, ready] of [[false, true], [true, false], [true, true]]) {
    await page.route("**/api/v1/access/me", route => route.fulfill({ json: allowed ? screenAccess("/payroll/setup") : { is_ops: false, entries: [], decisions: {} } }));
    await page.route("**/api/v1/onboarding/modules", route => route.fulfill({ json: [{ key: "payroll", ready, unblock: null }] }));
    await page.evaluate(([allowed, ready]) => (window as unknown as { drawLink: (allowed: boolean, ready: boolean) => void }).drawLink(allowed!, ready!), [allowed!, ready!]);
    await expect.poll(() => page.evaluate(() => (window as unknown as { linkSettled: () => boolean }).linkSettled())).toBe(true);
    await dom(page.locator(`[data-link-state="${String(allowed)}${String(ready)}"]`)).toHaveCount(1);
    await dom(page.getByRole("link", { name: "직원 급여", exact: true })).toHaveCount(allowed && ready ? 1 : 0);
  }
  await dom(page.getByRole("link", { name: "직원 급여" })).toHaveAttribute("href", "/payroll/employees/synthetic");
  expect(errors).toEqual([]);
});

test("an incomplete contract focuses its first invalid fact", async () => {
  const writes: unknown[] = [];
  await page.route("**/api/v1/payroll/employees/*/contract-wages", route => { writes.push(route.request().postDataJSON()); return route.fulfill({ status: 201, json: { id: "synthetic" } }); });
  await page.evaluate(() => (window as unknown as { drawForm: () => void }).drawForm());
  const form = page.locator("[data-composer-root]");
  await dom(form.getByRole("button", { name: commitLabel({ kind: "contractWage", mode: "save" }), exact: false })).toBeVisible();
  await form.getByRole("button", { name: commitLabel({ kind: "contractWage", mode: "save" }), exact: false }).click();
  await dom(form.locator("input:invalid").first()).toBeFocused();
  expect(writes).toEqual([]);
});
