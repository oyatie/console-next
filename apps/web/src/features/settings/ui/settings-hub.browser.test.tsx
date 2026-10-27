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
        import {createRootRoute,createRoute,createRouter,RouterProvider} from '@tanstack/react-router';
        import {loadCatalog} from '@console/i18n';
        import {SettingsHubView} from '/apps/web/src/features/settings/ui/settings-hub.tsx';
        import {SETTINGS_VIEWS} from '/apps/web/src/shell/settings-views.ts';
        import '/apps/web/src/app.css';
        await loadCatalog('ko');
        const root=createRootRoute({component:()=>React.createElement(SettingsHubView,{rows:SETTINGS_VIEWS})});
        const router=createRouter({routeTree:root.addChildren(SETTINGS_VIEWS.map(row=>createRoute({getParentRoute:()=>root,path:row.to})))});
        await router.load();
        createRoot(document.getElementById('root')).render(React.createElement(RouterProvider,{router}));
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
    await page.goto(`${server.resolvedUrls!.local[0]}settings-test`);
    await page.locator("html").evaluate((el, value) => { el.dataset.theme = value; }, theme);
    const main = page.getByRole("main");
    await expect(main.getByRole("heading", { level: 1, name: t("shell.link.settings"), exact: true })).toBeVisible();
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
