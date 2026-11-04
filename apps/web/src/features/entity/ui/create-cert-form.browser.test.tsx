// SPDX-License-Identifier: LicenseRef-Proprietary
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { expect as dom } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, expect, test } from "vitest";
import { browserTestOptimizeDeps, chromium, type Browser, type Page } from "../../../lib/browser-test";
import { mockRoute } from "../../../../../../e2e/mock/route";

let server: ViteDevServer;
let browser: Browser;
let page: Page;
beforeAll(async () => {
  server = await createServer({
    configFile: false, cacheDir: ".cache/entity-cert-test", logLevel: "error",
    optimizeDeps: browserTestOptimizeDeps,
    resolve: { dedupe: ["react", "react-dom"] },
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, fs: { allow: [resolve("."), realpathSync("node_modules/pretendard")] } },
    plugins: [{
      name: "entity-cert-test",
      resolveId: id => id === "/cert-test.js" ? "\0cert-test" : undefined,
      load: id => id === "\0cert-test" ? `
        import { createElement as h, useState } from 'react';
        import { createRoot } from 'react-dom/client';
        import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
        import { configure } from '@console/api';
        import { webPlatform } from '@console/api/web';
        import { loadCatalog } from '@console/i18n';
        import { CertForm } from '/apps/web/src/features/entity/ui/create-cert-form.tsx';
        import { emptyDraft } from '/apps/web/src/features/entity/domain/draft.ts';
        import s from '/apps/web/src/features/entity/ui/entity-create.module.css';
        import '/apps/web/src/app.css';
        configure(webPlatform);
        await loadCatalog('ko');
        function Demo() {
          const params = new URLSearchParams(location.search);
          const [draft, setDraft] = useState(() => ({ ...emptyDraft(), bizKind: params.get('kind'),
            businessAddress: params.has('address') ? { road: '검증로 123', zip: '06236', detail: '', verified: false } : null }));
          const form = h(CertForm, { c: { draft, put: (key, value) => setDraft(d => ({ ...d, [key]: value })), problems: {}, brnClasses: [], today: '2026-10-27', crnWarn: false } });
          return params.has('frame') ? h('div', { className: s.page }, h('div', { className: s.body }, h('section', { className: 'card ' + s.main }, h('div', { className: s.cardBody }, form)))) : form;
        }
        createRoot(document.getElementById('root')).render(h(QueryClientProvider, { client: new QueryClient() }, h(Demo)));
      ` : undefined,
      configureServer: vite => { vite.middlewares.use((req, res, next) => {
        if (req.url?.split("?")[0] !== "/cert-test") return next();
        res.setHeader("Content-Type", "text/html");
        res.end('<!doctype html><html lang="ko"><title>Certificate</title><div id="root"></div><script type="module" src="/cert-test.js"></script></html>');
      }); },
    }],
  });
  await server.listen();
  browser = await chromium.launch();
  page = await browser.newPage();
  page.setDefaultTimeout(4000);
  await mockRoute(page, "get", "/api/v1/ref/lists/{key}/codes", { status: 200, json: { list: { key: "fixture", status: "NOT_LOADED" }, items: [] } });
}, 60_000);
afterAll(async () => { await browser?.close(); await server?.close(); });

test.each(["CORPORATION", "INDIVIDUAL"])("%s: choosing Y then N preserves every radio description/error target", async kind => {
  await page.goto(`${server.resolvedUrls!.local[0]}cert-test?kind=${kind}`);
  const group = page.getByRole("radiogroup", { name: /사업자 단위 과세 적용/ });
  for (const name of ["여", "부"]) {
    const radio = group.getByRole("radio", { name, exact: true });
    await group.getByText(name, { exact: true }).click();
    await dom(radio).toBeChecked();
    await dom(group).toHaveAccessibleName(/사업자 단위 과세 적용/);
    expect(await group.getByRole("radio").evaluateAll(radios => radios.flatMap(input =>
      ["aria-describedby", "aria-errormessage"].flatMap(attr => (input.getAttribute(attr) ?? "").split(/\s+/).filter(id => id && !document.getElementById(id))),
    ))).toEqual([]);
  }
});

test("the corporation certificate fits its 390px page column with a wider fallback font", async () => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto(`${server.resolvedUrls!.local[0]}cert-test?kind=CORPORATION&address=1&frame=1`);
  await page.locator("html").evaluate((html) => { html.dataset.fontFallback = ""; });
  const address = page.getByRole("button", { name: "주소 다시 찾기" }).locator("..");
  const overflow = await address.locator("span").first().evaluate((lines) => lines.scrollWidth - lines.clientWidth);
  expect(overflow).toBe(0);
});

test("the head-office address search fits the phone column despite its intrinsic input width", async () => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto(`${server.resolvedUrls!.local[0]}cert-test?kind=CORPORATION&frame=1`);
  const address = page.getByRole("combobox", { name: /본점 소재지/ });
  // Native input widths vary with the browser's font metrics.
  await address.evaluate(input => input.setAttribute("size", "40"));
  for (const theme of ["light", "dark"]) {
    await page.locator("html").evaluate((html, value) => { html.dataset.theme = value; }, theme);
    expect(await address.evaluate(input =>
      input.parentElement!.scrollWidth - input.parentElement!.clientWidth,
    )).toBe(0);
  }
});
