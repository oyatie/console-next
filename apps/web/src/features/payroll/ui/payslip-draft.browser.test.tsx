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
        window.draw=(mode)=>root.render(React.createElement(PayslipDraftView,{data:{...draft,issuable:true,gross_won:mode==='unsafe'?Number.MAX_SAFE_INTEGER+1:draft.gross_won,minimum_wage_check:{...draft.minimum_wage_check,instrument:{...draft.minimum_wage_check.instrument,url:mode==='held'?'':draft.minimum_wage_check.instrument.url},hourly_floor_won:mode==='unsafe'?1.5:draft.minimum_wage_check.hourly_floor_won,passes:mode==='below'?false:mode==='incomparable'?null:true},blockers:[...draft.blockers,...(mode==='below'?['최저임금 미달: raw backend sentence']:[])],contract:mode==='no-source'?{...draft.contract,source_note:''}:draft.contract,deductions:draft.deductions.map(row=>({...row,blocked_by:mode==='blocked'?'unresolved':null,share_instrument:mode==='held'?{...row.instrument,url:''}:null,instrument:{...row.instrument,url:mode==='held'?'':row.instrument.url}}))}}));
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
    await page.evaluate(value => (window as unknown as { draw: (value: string) => void }).draw(value), mode);
    await dom(page.getByRole("region", { name: "공제 초안과 근거", exact: true }).getByText("34,567원", { exact: true })).toHaveCount(mode === "blocked" ? 0 : 2);
    await dom(page.getByText("3,456,789원", { exact: true })).toHaveCount(mode === "no-source" ? 0 : 3);
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

test("blockers list retains attendance and cites the typed minimum-wage failure", async () => {
  for (const [mode, label] of [["below", "최저임금에 미달합니다."], ["incomparable", "최저임금을 비교할 수 없습니다."]] as const) {
    await page.evaluate(value => (window as unknown as { draw: (value: string) => void }).draw(value), mode);
    const blockers = page.getByRole("list", { name: "확인 필요 사항" });
    await dom(blockers.getByText("근태 기록이 충분하지 않습니다.", { exact: true })).toBeVisible();
    const minimum = blockers.getByRole("listitem").filter({ hasText: label });
    await dom(minimum).toBeVisible();
    await dom(minimum.getByRole("link")).toHaveAttribute("href", "https://example.com/payroll-source");
    await dom(minimum).toContainText("2026. 01. 01.");
    await dom(page.getByText(/raw backend sentence/)).toHaveCount(0);
  }
});
test("held instruments render once per citation cell on mobile", async () => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.evaluate(() => (window as unknown as { draw: (mode: string) => void }).draw("held"));
  const deductions = page.getByRole("region", { name: "공제 초안과 근거", exact: true });
  await dom(deductions.getByText("근거 확인 필요근거 확인 필요", { exact: true })).toHaveCount(0);
  await dom(deductions.getByText("근거 확인 필요", { exact: true })).toHaveCount(4);
  const minimum = page.getByRole("region", { name: "최저임금 확인", exact: true });
  await dom(minimum.getByRole("link")).toHaveCount(0);
  await dom(minimum.getByText("12,345원", { exact: true })).toHaveCount(0);
  await page.setViewportSize({ width: 1280, height: 720 });
});

test("draft facts hold unsafe amounts", async () => {
  await page.evaluate(() => (window as unknown as { draw: (mode: string) => void }).draw("cited"));
  await dom(page.getByText("12,345원", { exact: true })).toBeVisible();
  await page.evaluate(() => (window as unknown as { draw: (mode: string) => void }).draw("unsafe"));
  await dom(page.getByText("9,007,199,254,740,992원", { exact: true })).toHaveCount(0);
  await dom(page.getByText("1.5원", { exact: true })).toHaveCount(0);
});
