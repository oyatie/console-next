// SPDX-License-Identifier: LicenseRef-Proprietary
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type Browser, type Page } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, expect, test } from "vitest";
import { browserTestOptimizeDeps } from "../../../lib/browser-test";

let server: ViteDevServer;
let browser: Browser;
let page: Page;

beforeAll(async () => {
  await loadCatalog("ko");
  server = await createServer({
    configFile: false, cacheDir: ".cache/dept-name-test", logLevel: "error",
    optimizeDeps: browserTestOptimizeDeps,
    resolve: { dedupe: ["react", "react-dom"] },
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, fs: { allow: [resolve("."), realpathSync("node_modules/pretendard")] } },
    plugins: [{
      name: "dept-name-test",
      enforce: "pre",
      resolveId: (id) => id === "/dept-name-test.js" ? "\0dept-name-test"
        : /(?:^|\/)use-govern(?:\.ts)?$/.test(id) ? "\0govern-stub" : undefined,
      load: (id) => id === "\0govern-stub" ? `
        export const useGovern = () => ({ g: { date: '2026-11-03', reason: '조직 운영 개선' }, set: () => {}, today: '2026-11-03', missing: [], late: false, routed: false, mode: 'apply' });
        export const useGovernSubmit = () => ({ isPending: false, error: null, mutate: () => {} });
      ` : id === "\0dept-name-test" ? `
        import { createElement as h, useState } from 'react';
        import { createRoot } from 'react-dom/client';
        import { flushSync } from 'react-dom';
        import { loadCatalog } from '@console/i18n';
        import { DeptNameComposer } from '/apps/web/src/features/org/ui/dept-name-composer.tsx';
        import '/apps/web/src/app.css';
        await loadCatalog('ko');
        const node = (id, kind, name, children = []) => ({ id, kind, name, version: 1, headcount: 0, direct_headcount: 0, dispatched_headcount: 0, chips: [], children });
        const entity = node('entity', 'LEGAL_ENTITY', '검증법인');
        const initial = node('workplace', 'WORKPLACE', '본사');
        const applied = node('workplace', 'WORKPLACE', '본사', [node('created', 'DEPARTMENT', '마케팅팀')]);
        const place = (workplace) => ({ node: workplace, parent: entity, entity, workplace, path: [entity.name] });
        function Demo() {
          const [current, setCurrent] = useState(initial);
          window.applyTree = () => flushSync(() => setCurrent(applied));
          return h(DeptNameComposer, { mode: 'create', place: place(current), onClose: () => {} });
        }
        createRoot(document.getElementById('root')).render(h(Demo));
      ` : undefined,
      configureServer: vite => { vite.middlewares.use((req, res, next) => {
        if (req.url !== "/dept-name-test") return next();
        res.setHeader("Content-Type", "text/html");
        res.end('<html lang="ko"><title>Department proposal</title><div id="root"></div><script type="module" src="/dept-name-test.js"></script></html>');
      }); },
    }],
  });
  await server.listen();
  browser = await chromium.launch();
  page = await browser.newPage();
  page.setDefaultTimeout(10_000);
}, 60_000);

afterAll(async () => { await browser?.close(); await server?.close(); });

for (const width of [1440, 390]) test(`an applied tree cannot revise the open department proposal at ${width}px`, async () => {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`${server.resolvedUrls!.local[0]}dept-name-test`);
  await page.locator("html").evaluate(element => { element.dataset.theme = "dark"; });
  const field = page.getByRole("textbox", { name: new RegExp(`^${t("orgUnit.gov.name")}`) });
  await field.fill("마케팅팀");
  const controls = () => Promise.all([
    field.boundingBox(),
    page.getByRole("button", { name: t("composer.dismiss"), exact: true }).boundingBox(),
  ]);
  const before = await controls();
  await page.evaluate(() => (window as typeof window & { applyTree: () => void }).applyTree());
  await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => done())));
  expect(await page.getByText(t("orgUnit.add.taken", { parent: "본사" }), { exact: true }).count()).toBe(0);
  expect(await controls()).toEqual(before);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
});
