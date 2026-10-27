// SPDX-License-Identifier: LicenseRef-Proprietary
import { resolve } from "node:path";
import { expect as dom } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, test } from "vitest";
import { browserTestOptimizeDeps, chromium, openBrowserTestPage, type Browser, type Page } from "../lib/browser-test";

let server: ViteDevServer;
let browser: Browser;
let page: Page;

beforeAll(async () => {
  server = await createServer({
    configFile: false, cacheDir: ".cache/enum-value-test", logLevel: "error",
    optimizeDeps: browserTestOptimizeDeps,
    resolve: { dedupe: ["react", "react-dom"] },
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, fs: { allow: [resolve(".")] } },
    plugins: [{
      name: "enum-value-test",
      resolveId: id => id === "/enum-value-test.js" ? "\0enum-value-test" : undefined,
      load: id => id === "\0enum-value-test" ? `
        import { createElement as h } from 'react';
        import { createRoot } from 'react-dom/client';
        import { i18n, loadCatalog } from '@console/i18n';
        import { ORG_CHANGE_STATUS, LEAVE_TYPE, IMPORT_OUTCOME, IMPORT_RUN_STATUS, IMPORT_SHEET_STATUS, SUPPORT_SESSION_STATE, ATTENDANCE_PATTERN_STATUS } from '/apps/web/src/lib/labels.ts';
        import { EnumValue } from '/apps/web/src/ui/enum-value.tsx';
        const locale = new URLSearchParams(location.search).get('locale');
        i18n.set(locale);
        await loadCatalog(locale);
        createRoot(document.getElementById('root')).render(h('main', null,
          h('div', { id: 'known' }, h(EnumValue, { e: ORG_CHANGE_STATUS, value: 'REJECTED' })),
          h('div', { id: 'unknown' }, h(EnumValue, { e: ORG_CHANGE_STATUS, value: 'FUTURE_STATUS' })),
          h('div', { id: 'leave' }, h(EnumValue, { e: LEAVE_TYPE, value: 'FUTURE_LEAVE' })),
          h('div', { id: 'support-unknown' }, h(EnumValue, { e: SUPPORT_SESSION_STATE, value: 'FUTURE_SESSION' })),
          ...[[IMPORT_OUTCOME, 'refused'], [IMPORT_RUN_STATUS, 'PREVIEWED'], [IMPORT_RUN_STATUS, 'FAILED'], [IMPORT_SHEET_STATUS, 'needs_mapping'], [SUPPORT_SESSION_STATE, 'ACTIVE'], [ATTENDANCE_PATTERN_STATUS, 'RETIRED']].map(([e, value], i) =>
            h('div', { className: 'migrated', key: i }, h(EnumValue, { e, value })))));
      ` : undefined,
      configureServer: vite => { vite.middlewares.use((req, res, next) => {
        if (req.url?.split("?")[0] !== "/enum-value-test") return next();
        res.setHeader("Content-Type", "text/html");
        res.end('<html lang="ko"><title>EnumValue</title><div id="root"></div><script type="module" src="/enum-value-test.js"></script></html>');
      }); },
    }],
  });
  await server.listen();
  browser = await chromium.launch();
  page = await browser.newPage();
}, 60_000);

afterAll(async () => { await browser?.close(); await server?.close(); });

test.each([["ko", "반려됨", "확인되지 않은 항목"], ["en", "Rejected", "Unrecognized value"]])(
  "%s renders catalog words, registry tones and future diagnostic codes in Chromium", async (locale, rejected, unknown) => {
    await openBrowserTestPage(page, `${server.resolvedUrls!.local[0]}enum-value-test?locale=${locale}`, page.locator("#known .chip"));
    await dom(page.locator("#known .chip--danger")).toHaveText(rejected);
    await dom(page.locator("#unknown .chip--neutral")).toHaveText("FUTURE_STATUS");
    await dom(page.locator("#leave")).toContainText(unknown);
    await dom(page.locator("#leave .chip--neutral")).toHaveText("FUTURE_LEAVE");
    await dom(page.locator("#support-unknown")).toHaveText(`${unknown} FUTURE_SESSION`);
    await dom(page.locator("#support-unknown .chip--neutral")).toHaveText("FUTURE_SESSION");
    await dom(page.locator(".migrated .chip")).toHaveText(locale === "ko"
      ? ["반영 불가", "미리보기", "반영하지 못했습니다", "연결 필요", "지원 중", "사용 중지"]
      : ["Cannot apply", "Preview", "The apply stopped", "Needs mapping", "Active", "Retired"]);
  },
);
