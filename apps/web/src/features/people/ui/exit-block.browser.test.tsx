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
  const mocks: Record<string, string> = {
    "@tanstack/react-query": "export const useQuery=()=>({data:{items:window.exitRows},isSuccess:true});",
    "@tanstack/react-router": "import {createElement} from 'react'; export const getRouteApi=()=>({useNavigate:()=>()=>{}}); export const Link=({children})=>createElement('a',{},children);",
    "../../../reference/authz/ui/use-can": "export const useCan=()=>()=>true;",
    "../../../lib/react/query-state": "export const QueryState=({children})=>children({items:window.exitRows});",
    "../api": "export const exitCasesQuery=()=>({}); export const caseQuery=()=>({});",
    "../present": "export const whoLine=()=>'';",
    "./exit-facts": "export const RelDay=()=>null;",
    "./use-case-actions": "export const useOwnRecord=()=>false; export const useCaseActions=()=>({next:'confirm_exit',forward:'confirm_exit',back:[]});",
    "./exit-report": "export const ReportForm=({onDone})=>{window.exitReceipt=()=>onDone(window.exitMessage,'exit-case');return null;};",
    "./exit-axis": "export const StepForm=()=>null;",
    "./exit-close": "export const CloseForm=()=>null;",
  };
  server = await createServer({ configFile: false, cacheDir: ".cache/exit-receipt-test", logLevel: "error",
    optimizeDeps: browserTestOptimizeDeps,
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, fs: { allow: [resolve("."), realpathSync("node_modules/pretendard")] } },
    plugins: [{ name: "exit-receipt-test", enforce: "pre",
      transform: (code, id) => {
        if (!id.split("?")[0]!.endsWith("/exit-block.tsx")) return;
        for (const [index, name] of Object.keys(mocks).entries()) code = code.replaceAll(JSON.stringify(name), JSON.stringify(`exit-receipt-mock:${index}`));
        return code;
      },
      resolveId: (id) => id === "/exit-receipt-test.js" ? "\0exit-receipt-test" : id.startsWith("exit-receipt-mock:") ? `\0${id}` : undefined,
      load: (id) => id.startsWith("\0exit-receipt-mock:") ? Object.values(mocks)[Number(id.slice("\0exit-receipt-mock:".length))] : id === "\0exit-receipt-test" ? `
        import {createElement} from 'react'; import {createRoot} from 'react-dom/client'; import {flushSync} from 'react-dom';
        import {loadCatalog,t} from '@console/i18n';
        import {ExitCases} from '/apps/web/src/features/people/ui/exit-block.tsx'; import '/apps/web/src/app.css';
        await loadCatalog('ko'); window.exitRows=[]; window.exitMessage=t('exit.reported',{name:'한기록'});
        const root=createRoot(document.getElementById('root'));
        let act;
        const render=()=>root.render(createElement(ExitCases,{employee:{id:'person',name:'한기록',status:'ACTIVE'},act}));
        flushSync(render);
        window.openExit=()=>flushSync(()=>{act='exit.report';render();});
        window.closeExit=()=>flushSync(()=>{act=undefined;render();});
        window.readExit=()=>flushSync(()=>{window.exitRows=[{id:'exit-case',status:'REPORTED',effective_exit_date:'2026-10-25'}];render();});
        window.finishExit=()=>flushSync(()=>{window.exitReceipt();act=undefined;render();});
      ` : undefined,
      configureServer: (vite) => { vite.middlewares.use((req, res, next) => {
        if (req.url !== "/exit-receipt-test") return next();
        res.setHeader("Content-Type", "text/html"); res.end('<div id="root" style="max-width:var(--card-w)"></div><script type="module" src="/exit-receipt-test.js"></script>');
      }); },
    }],
  });
  await server.listen(); browser = await chromium.launch(); page = await browser.newPage();
  await page.goto(`${server.resolvedUrls!.local[0]}exit-receipt-test`);
  await page.getByRole("button", { name: "퇴직 보고", exact: true }).waitFor();
}, 60_000);
afterAll(async () => { await browser?.close(); await server?.close(); });

test.each([1440, 390])("an idle or reloaded exit card has no receipt gap at %s px", async (width) => {
  await page.setViewportSize({ width, height: 1000 });
  await page.goto(`${server.resolvedUrls!.local[0]}exit-receipt-test`);
  await page.getByRole("button", { name: "퇴직 보고", exact: true }).waitFor();
  const slot = page.locator('[class*="receiptSlot"]');
  expect(await slot.count()).toBe(0);
  await page.evaluate(() => (window as unknown as { openExit: () => void }).openExit());
  expect((await slot.boundingBox())!.height).toBeGreaterThan(0);
  await page.evaluate(() => (window as unknown as { closeExit: () => void }).closeExit());
  expect(await slot.count()).toBe(0);
  await page.evaluate(() => (window as unknown as { readExit: () => void }).readExit());
  expect(await slot.count()).toBe(0);
});

test.each([1440, 390])("a late report receipt keeps the next exit control in place at %s px", async (width) => {
  await page.setViewportSize({ width, height: 1000 });
  await page.goto(`${server.resolvedUrls!.local[0]}exit-receipt-test`);
  await page.getByRole("button", { name: "퇴직 보고", exact: true }).waitFor();
  expect(await page.getByRole("status").count()).toBe(0);
  await page.evaluate(() => (window as unknown as { openExit: () => void }).openExit());
  const reserved = (await page.locator('[class*="receiptSlot"]').boundingBox())!.height;
  await page.evaluate(() => (window as unknown as { readExit: () => void }).readExit());
  const control = page.getByRole("button", { name: "인사 확인하고 퇴직 처리", exact: true });
  const before = (await control.boundingBox())!;
  await page.evaluate(() => (window as unknown as { finishExit: () => void }).finishExit());
  await page.getByRole("status").getByText("한기록의 퇴직을 보고했습니다", { exact: true }).waitFor();
  expect((await control.boundingBox())!.y).toBe(before.y);
  expect((await page.locator('[class*="receiptSlot"]').boundingBox())!.height).toBe(reserved);
});
