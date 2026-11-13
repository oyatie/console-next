// SPDX-License-Identifier: LicenseRef-Proprietary
import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { expect, type Browser, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, test } from "vitest";
import { browserEngine, browserTestOptimizeDeps } from "../../../lib/browser-test";
import type { ApprovalDocument, ApprovalItem } from "../api";

const items: ApprovalItem[] = [{
  id: "approval-1", box: "pending", title: "영업 조직 개편안", summary: "영업1팀과 영업2팀을 하나의 조직으로 합칩니다.", document_no: "AP-2026-001",
  source: { key: "org_change", label: "조직 변경" }, status: { key: "waiting", label: "내 결재 대기", tone: "warn" },
  requester: { id: "account-1", name: "김기안", role: "인사팀" }, requested_at: "2026-11-03T01:00:00Z", due_at: "2026-11-05T01:00:00Z",
  facts: [{ key: "effective", label: "시행일", value: "2026. 11. 10." }],
  route: [
    { id: "draft", label: "기안", assignee: "김기안", state: "done", meta: "11. 3. 10:00" },
    { id: "approve", label: "인사팀장 결재", assignee: "박결재", state: "current", meta: "내 차례" },
  ],
  viewer: { kind: "org_change", id: "change-1" },
}];
const approvalDocument: ApprovalDocument = {
  ...items[0]!, body: [{ key: "change", label: "변경 내용", value: "영업1팀과 영업2팀을 영업팀으로 통합" }],
  revision: 1, fingerprint: "sha256:approval-1-r1", consequence: "승인하면 조직 변경이 시행일에 반영됩니다.",
  opinion_max: 1000, my_actions: { kind: "none" },
};

const ENGINES = [browserEngine()];
let server: ViteDevServer;
const sessions: { browser: Browser; page: Page }[] = [];

beforeAll(async () => {
  server = await createServer({
    configFile: false, cacheDir: ".cache/approvals-view-test", logLevel: "error", optimizeDeps: browserTestOptimizeDeps,
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, fs: { allow: [resolve("."), dirname(realpathSync("node_modules/pretendard"))] } },
    plugins: [{
      name: "approvals-view-test",
      resolveId: id => id === "/approvals-view-test.js" ? "\0approvals-view-test" : undefined,
      load: id => id === "\0approvals-view-test" ? `
        import React,{useState} from 'react'; import {QueryClient,QueryClientProvider} from '@tanstack/react-query'; import {createRoot} from 'react-dom/client';
        import {createMemoryHistory,createRootRoute,createRoute,createRouter,Outlet,RouterProvider} from '@tanstack/react-router';
        import {i18n,loadCatalog} from '@console/i18n';
        import {ApprovalInboxView} from '/apps/web/src/features/approvals/ui/approvals-page.tsx';
        import {ApprovalDocumentView} from '/apps/web/src/features/approvals/ui/approval-viewer.tsx';
        import '/apps/web/src/app.css';
        const locale=new URL(location.href).searchParams.get('locale')??'ko'; await loadCatalog(locale); i18n.set(locale);
        const items=${JSON.stringify(items)},approvalDocument=${JSON.stringify(approvalDocument)};
        approvalDocument.decision_refusal=new URL(location.href).searchParams.get('refusal');
        function Demo(){const [id,setId]=useState();return React.createElement(ApprovalInboxView,{items,sel:id,selected:items.find(x=>x.id===id),record:React.createElement(ApprovalDocumentView,{document:approvalDocument}),onSelect:setId,onClose:()=>setId(undefined)});}
        const root=createRootRoute({component:Outlet});
        const inbox=createRoute({getParentRoute:()=>root,path:'/',component:Demo});
        const destination=createRoute({getParentRoute:()=>root,path:'/org/changes/$id',component:()=>null});
        const approval=createRoute({getParentRoute:()=>root,path:'/approvals/$approvalId',component:()=>React.createElement(ApprovalDocumentView,{document:approvalDocument})});
        const router=createRouter({routeTree:root.addChildren([inbox,destination,approval]),history:createMemoryHistory({initialEntries:[new URL(location.href).searchParams.get('route')??'/']})});
        await router.load(); createRoot(document.getElementById('root')).render(React.createElement(QueryClientProvider,{client:new QueryClient()},React.createElement(RouterProvider,{router})));
      ` : undefined,
      configureServer: vite => { vite.middlewares.use((req, res, next) => {
        if (req.url?.split("?")[0] !== "/approvals-view-test") return next();
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end('<!doctype html><html lang="ko"><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>결재함</title></head><body><main class="main"><div class="page" id="root"></div></main><script type="module" src="/approvals-view-test.js"></script></body></html>');
      }); },
    }],
  });
  await server.listen();
  for (const engine of ENGINES) {
    const browser = await engine.launch();
    const page = await browser.newPage();
    sessions.push({ browser, page });
  }
}, 60_000);

afterAll(async () => { await Promise.all(sessions.map(({ browser }) => browser.close())); await server?.close(); });

test.each(ENGINES.map((_, engine) => ({ engine })))("read-only document explains its server refusal in engine $engine", async ({ engine }) => {
  const { page } = sessions[engine]!;
  const refusal = "org_change.refuse.identity_unbound";
  for (const [locale, message, body] of [
    ["ko", "요청자 또는 결정자의 본인 정보를 확인할 수 없어 거부했습니다.", "문서 내용"],
    ["en", "The requester or decider identity could not be verified.", "Document body"],
  ] as const) {
    await page.goto(`${server.resolvedUrls!.local[0]}approvals-view-test?route=${encodeURIComponent("/approvals/approval-1")}&refusal=${refusal}&locale=${locale}`);
    const facts = page.getByRole("region", { name: locale === "ko" ? "문서 정보" : "Document details", exact: true });
    const refusalText = facts.getByText(message, { exact: false });
    await expect(refusalText).toBeVisible();
    expect(await refusalText.evaluate(el => el.closest("[data-tone]")?.getAttribute("data-tone"))).toBe("warn");
    await expect(facts.getByRole("definition").filter({ hasText: message })).toHaveCount(0);
    const chain = page.getByRole("region", { name: locale === "ko" ? "결재선" : "Approval route", exact: true });
    await expect(chain).not.toContainText("내 차례");
    await expect(chain).toContainText("11. 3. 10:00");
    await expect(page.getByRole("button")).toHaveCount(0);
    await expect(page.getByRole("region", { name: body, exact: true })).toContainText("영업1팀과 영업2팀을 영업팀으로 통합");
  }
});

test.each(ENGINES.map((_, engine) => ({ engine })))("the document opens beside the list at phone and desktop widths in engine $engine", async ({ engine }) => {
  const { page } = sessions[engine]!;
  for (const width of [1440, 390]) for (const theme of ["light", "dark"]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${server.resolvedUrls!.local[0]}approvals-view-test`);
    await page.locator("html").evaluate((el, value) => { el.dataset.theme = value; }, theme);
    const row = page.getByRole("row", { name: /영업 조직 개편안/ });
    await expect(row.getByText("AP-2026-001", { exact: true })).toBeVisible();
    const chips = row.getByRole("list", { name: "결재선", exact: true });
    await expect(chips.getByRole("listitem")).toHaveCount(2);
    await expect(chips.locator('[aria-current="step"]')).toContainText("인사팀장 결재 · 박결재");
    await expect(row.getByText("김기안", { exact: true }).first()).toBeVisible();
    await row.click();
    const column = page.getByRole("complementary", { name: "결재 문서", exact: true });
    await expect(column.getByRole("heading", { name: "영업 조직 개편안", exact: true })).toBeVisible();
    await expect(column.getByRole("link", { name: "원본 기록 열기", exact: true })).toHaveAttribute("href", "/org/changes/change-1");
    const chain = column.getByRole("region", { name: "결재선", exact: true });
    const body = column.getByRole("region", { name: "문서 내용", exact: true });
    await expect(chain).toContainText("인사팀장 결재");
    expect((await chain.boundingBox())!.y).toBeLessThan((await body.boundingBox())!.y);
    await expect(page.getByRole("button", { name: /승인|반려|보완 요청/ })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
    expect(await page.locator("main").evaluate(el => el.scrollWidth - el.clientWidth)).toBe(0);
    // At phone width the list gives way to the document, so only 「돌아가기」 leads back.
    if (width === 390) await expect(row).toBeHidden();
    await column.getByRole("button", { name: width === 390 ? "돌아가기" : "상세 패널 닫기", exact: true }).click();
    await expect(column).toHaveCount(0);
    await expect(row).toBeFocused();
  }
}, 30_000);

test.each(ENGINES.map((_, engine) => ({ engine })))("Enter opens the document and Escape closes it in engine $engine", async ({ engine }) => {
  const { page } = sessions[engine]!;
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${server.resolvedUrls!.local[0]}approvals-view-test`);
  const row = page.getByRole("row", { name: /영업 조직 개편안/ });
  await row.focus();
  await page.keyboard.press("Enter");
  const column = page.getByRole("complementary", { name: "결재 문서", exact: true });
  await expect(column).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(column).toHaveCount(0);
  await expect(row).toBeFocused();
}, 30_000);

test.each(ENGINES.map((_, engine) => ({ engine })))("document viewer remains usable at phone and desktop widths in engine $engine", async ({ engine }) => {
  const { page } = sessions[engine]!;
  for (const width of [1440, 390]) for (const theme of ["light", "dark"]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${server.resolvedUrls!.local[0]}approvals-view-test?route=${encodeURIComponent("/approvals/approval-1")}`);
    await page.locator("html").evaluate((el, value) => { el.dataset.theme = value; }, theme);
    await expect(page.getByRole("region", { name: "문서 정보", exact: true })).toContainText("시행일");
    await expect(page.getByRole("region", { name: "결재선", exact: true })).toContainText("인사팀장 결재");
    await expect(page.getByRole("button", { name: /승인|반려|보완 요청/ })).toHaveCount(0);
    const chain = page.getByRole("region", { name: "결재선", exact: true });
    const body = page.getByRole("region", { name: "문서 내용", exact: true });
    expect((await chain.boundingBox())!.y).toBeLessThan((await body.boundingBox())!.y);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
    expect(await page.locator("main").evaluate(el => el.scrollWidth - el.clientWidth)).toBe(0);
  }
}, 30_000);
