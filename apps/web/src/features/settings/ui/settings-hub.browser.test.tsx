// SPDX-License-Identifier: LicenseRef-Proprietary
import { dirname, resolve } from "node:path";
import { realpathSync } from "node:fs";
import { afterAll, beforeAll, test } from "vitest";
import { expect } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { browserTestOptimizeDeps, chromium, type Browser, type Page } from "../../../lib/browser-test";
import { loadCatalog, t } from "@console/i18n";

let server: ViteDevServer;
let browser: Browser;
let page: Page;
beforeAll(async () => {
  await loadCatalog("ko");
  server = await createServer({
    configFile: false, cacheDir: ".cache/settings-test", logLevel: "error",
    define: { "process.env.VIRT_ON": "true" }, optimizeDeps: browserTestOptimizeDeps,
    resolve: { dedupe: ["react", "react-dom"] },
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, fs: { allow: [resolve("."), dirname(realpathSync("node_modules/pretendard"))] } },
    plugins: [{ name: "settings-test", resolveId: id => id === "/settings-test.js" ? "\0settings-test" : undefined,
      load: id => id === "\0settings-test" ? `
        import React from 'react'; import {createRoot} from 'react-dom/client';
        import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
        import {createRootRoute,createRoute,createRouter,RouterProvider} from '@tanstack/react-router';
        import {loadCatalog} from '@console/i18n';
        import {SettingsHubView} from '/apps/web/src/features/settings/ui/settings-hub.tsx';
        import {SETTINGS_VIEWS} from '/apps/web/src/shell/settings-views.ts';
        import '/apps/web/src/app.css';
        await loadCatalog('ko');
        const root=createRootRoute({component:()=>React.createElement(SettingsHubView,{rows:SETTINGS_VIEWS})});
        const router=createRouter({routeTree:root.addChildren(SETTINGS_VIEWS.map(row=>createRoute({getParentRoute:()=>root,path:row.to})))});
        await router.load();
        createRoot(document.getElementById('root')).render(React.createElement(QueryClientProvider,{client:new QueryClient({defaultOptions:{queries:{retry:false,staleTime:60000}}})},React.createElement(RouterProvider,{router})));
      ` : undefined }],
  });
  await server.listen();
  browser = await chromium.launch();
  page = await browser.newPage();
  await page.route("**/settings-test", route => route.fulfill({ contentType: "text/html", body: '<html lang="ko"><title>Settings</title><div id="root"></div><script type="module" src="/settings-test.js"></script></html>' }));
}, 60_000);
afterAll(async () => { await page?.close(); await browser?.close(); await server?.close(); });

for (const width of [1440, 390]) for (const theme of ["light", "dark"]) {
  test(`settings links support the keyboard at ${width}px in ${theme}`, async () => {
    await page.setViewportSize({ width, height: 900 });
    await page.route("**/api/v1/**", route => {
      const path = new URL(route.request().url()).pathname;
      const json = path.endsWith("company-domain/request") ? { pending_domain: "example.test" }
        : path.endsWith("employee-number-rules") ? [{ scope_kind: "TENANT", scope_id: "tenant", prefix: "E-", width: 4, next_number: "E-0012" }]
        : path.endsWith("settings") ? { can_change: false, items: [{ key: "approval.policy.org_structure", kind: { type: "code" }, value: "route", governance: "tenant", source: { layer: "tenant" }, scheduled: [{ value: "none", effective_from: "2026-12-01T00:00:00Z" }] }] }
        : { items: [] };
      return route.fulfill({ json });
    });
    await page.goto(`${server.resolvedUrls!.local[0]}settings-test`);
    await page.locator("html").evaluate((el, value) => { el.dataset.theme = value; }, theme);
    const main = page.getByRole("main");
    await expect(main.getByRole("heading", { level: 1, name: t("shell.link.settings"), exact: true })).toBeVisible();
    await expect(main.getByRole("region", { name: t("shell.settings.domain"), exact: true })).toContainText("example.test");
    await expect(main.getByRole("region", { name: t("identifiers.numbering.title"), exact: true })).toContainText("E-0012");
    const approval = main.getByRole("region", { name: "결재", exact: true });
    await expect(approval).toContainText("조직 개편");
    await expect(approval).toContainText("2026. 12. 01.");
    await expect(approval.getByRole("link")).toHaveCount(0);
    const links = main.getByRole("link");
    await expect(links).toHaveCount(4);
    await page.keyboard.press("Tab");
    await expect(links.first()).toBeFocused();
    for (let i = 1; i < 4; i++) {
      await page.keyboard.press("Tab");
      await expect(links.nth(i)).toBeFocused();
    }
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/people\/period-locks$/);
    expect(await main.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  });
}

for (const status of [403, 503]) test(`one ${status} summary leaves other cards and links available`, async () => {
  await page.route("**/api/v1/tenant/company-domain/request", route => route.fulfill({ status, json: { error: { code: "forbidden", message: "" } } }));
  await page.goto(`${server.resolvedUrls!.local[0]}settings-test`);
  const main = page.getByRole("main");
  await expect(main.getByRole("region", { name: t("shell.settings.domain"), exact: true })).toContainText("확인 불가");
  await expect(main.getByRole("region", { name: t("identifiers.numbering.title"), exact: true })).toContainText("E-0012");
  await expect(main.getByRole("link")).toHaveCount(4);
  await page.unroute("**/api/v1/tenant/company-domain/request");
});
