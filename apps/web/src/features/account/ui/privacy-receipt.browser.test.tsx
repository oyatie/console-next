// SPDX-License-Identifier: LicenseRef-Proprietary
import { resolve } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import { expect as browserExpect } from "@playwright/test";
import { chromium, browserTestOptimizeDeps, type Browser, type Page } from "../../../lib/browser-test";

let server: ViteDevServer;
let browser: Browser;
let pages: Page[];
beforeAll(async () => {
  server = await createServer({
    configFile: false, cacheDir: ".cache/privacy-receipt-test", logLevel: "error",
    optimizeDeps: browserTestOptimizeDeps, resolve: { dedupe: ["react", "react-dom"] },
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, fs: { allow: [resolve(".")] } },
    plugins: [{ name: "privacy-receipt-test",
      resolveId: id => id === "/receipt.js" ? "\0receipt" : undefined,
      load: id => id === "\0receipt" ? `
        import {createElement as h} from 'react';
        import {createRoot} from 'react-dom/client';
        import {loadCatalog} from '@console/i18n';
        import {PrivacyReceipt} from '/apps/web/src/features/account/ui/privacy-receipt.tsx';
        await loadCatalog('ko');
        const closed = location.search.includes('closed');
        createRoot(document.getElementById('root')).render(h(PrivacyReceipt,{request:{
          id:'request-1',receipt_no:'RR-001',controller_label:'모의테스트상사',kinds:[{code:'ACCESS',label:'열람'}],
          detail:closed?'':'계정 기록',received_at:'2026-11-01T00:00:00Z',status:{code:'RECEIVED',label:'접수',tone:'info'},
          clock:closed?null:{due_at:'2026-11-11T00:00:00Z',days_left:-2,severity:'over'},
          outcomes:closed?[{kind_label:'열람',outcome_label:'일부 수용',reason_label:'다른 사람의 권익 침해',note:'제삼자 정보 제외'}]:[],
          notified_at:closed?'2026-11-04T00:00:00Z':null,objection_method:null,retention_notice:null
        }}));
      ` : undefined,
      configureServer: vite => { vite.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith("/receipt?")) return next();
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end('<!doctype html><html lang="ko"><head><title>권리 요구</title></head><body><main id="root"></main><script type="module" src="/receipt.js"></script></body></html>');
      }); },
    }],
  });
  await server.listen();
  browser = await chromium.launch();
  pages = await Promise.all([browser.newPage(), browser.newPage()]);
}, 60_000);
afterAll(async () => { await browser?.close(); await server?.close(); });

test.each([false, true])("receipt uses the server clock and leaves unresolved retention marked (closed=%s)", async closed => {
  const page = pages.shift()!;
  try {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${server.resolvedUrls!.local[0]}receipt?${closed ? "closed" : "open"}`);
    await browserExpect(page.getByText("RR-001", { exact: true })).toBeVisible();
    await browserExpect(page.getByText(closed ? "작성한 내용 없음" : "계정 기록", { exact: true })).toBeVisible();
    await browserExpect(page.getByText("【확인 필요】 보존 기간 미정", { exact: true })).toBeVisible();
    await browserExpect(page.getByText("2일 지남", { exact: true })).toHaveCount(closed ? 0 : 1);
    if (closed) {
      await browserExpect(page.getByText("다른 사람의 권익 침해", { exact: true })).toBeVisible();
      await browserExpect(page.getByText("제삼자 정보 제외", { exact: true })).toBeVisible();
      await browserExpect(page.getByText("【확인 필요】 이의 제기 방법 미등록", { exact: true })).toBeVisible();
      await browserExpect(page.getByText("결과 통지 일시", { exact: true })).toBeVisible();
    }
    expect(errors).toEqual([]);
  } finally { await page.close(); }
});
