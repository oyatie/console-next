// SPDX-License-Identifier: LicenseRef-Proprietary
import { dirname, resolve } from "node:path";
import { realpathSync } from "node:fs";
import { afterAll, beforeAll, expect, test } from "vitest";
import { expect as element } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { browserTestOptimizeDeps, chromium, type Browser, type Page } from "../../lib/browser-test";

let server: ViteDevServer;
let browser: Browser;
let page: Page;
beforeAll(async () => {
  server = await createServer({
    configFile: false, cacheDir: ".cache/tabs-test", logLevel: "error",
    optimizeDeps: browserTestOptimizeDeps, resolve: { dedupe: ["react", "react-dom"] },
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, fs: { allow: [resolve("."), dirname(realpathSync("node_modules/pretendard"))] } },
    plugins: [{ name: "tabs-test", resolveId: id => id === "/tabs-test.js" ? "\0tabs-test" : undefined,
      load: id => id === "\0tabs-test" ? `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router';
        import { loadCatalog } from '@console/i18n';
        import TabsGallery from '/apps/web/src/ui/tabs/tabs.gallery.tsx';
        import '/apps/web/src/app.css';
        await loadCatalog('ko');
        const root = createRootRoute();
        const route = createRoute({ getParentRoute: () => root, path: '/tabs-test', component: TabsGallery });
        const router = createRouter({ routeTree: root.addChildren([route]) });
        createRoot(document.getElementById('root')).render(React.createElement(RouterProvider, { router }));
      ` : undefined }],
  });
  await server.listen();
  browser = await chromium.launch();
  page = await browser.newPage();
  await page.route(/\/tabs-test(?:\?.*)?$/, route => route.fulfill({ contentType: "text/html", body: '<html lang="ko"><title>Tabs</title><main id="root"></main><script type="module" src="/tabs-test.js"></script></html>' }));
}, 60_000);
afterAll(async () => { await browser?.close(); await server?.close(); });

test.each([1440, 390, 320])("the gallery's record tabs keep their panels outside the shared head at %spx", async width => {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`${server.resolvedUrls!.local[0]}tabs-test`);
  const tabs = page.getByRole("tablist", { name: "보기", exact: true });
  await element(page.locator("header").getByRole("tablist")).toBeVisible();
  const selected = tabs.getByRole("tab", { selected: true });
  await selected.focus();
  await selected.press("ArrowRight");
  await element(selected).toHaveAccessibleName("목록 61");
  const panel = page.locator('[data-tabs-demo="url"]').getByRole("tabpanel");
  await element(panel).toHaveText("목록 보기입니다.");
  expect(await panel.evaluate(el => Boolean(el.closest("header")))).toBe(false);
  await selected.press("End");
  await element(selected).toHaveAccessibleName("아웃라인");
  await selected.press("Home");
  await element(selected).toHaveAccessibleName("조직도");
  await element(tabs.locator('[tabindex="0"]')).toHaveCount(1);
  expect(await page.evaluate(() => document.scrollingElement!.scrollWidth - innerWidth)).toBe(0);
});

test("URL tabs restore deep links, preserve other filters and follow browser history", async () => {
  await page.goto(`${server.resolvedUrls!.local[0]}tabs-test?tab=list&scope=workplace#record`);
  const tabs = page.getByRole("tablist", { name: "보기", exact: true });
  await element(tabs.getByRole("tab", { selected: true })).toHaveAccessibleName("목록 61");
  await tabs.getByRole("tab", { name: "아웃라인", exact: true }).click();
  await element(page).toHaveURL(/tab=outline.*scope=workplace#record$/);
  await page.reload();
  await element(tabs.getByRole("tab", { selected: true })).toHaveAccessibleName("아웃라인");
  await page.goBack();
  await element(tabs.getByRole("tab", { selected: true })).toHaveAccessibleName("목록 61");
  await page.goForward();
  await element(tabs.getByRole("tab", { selected: true })).toHaveAccessibleName("아웃라인");
  await tabs.getByRole("tab", { name: "조직도", exact: true }).click();
  await element(page).toHaveURL(/scope=workplace#record$/);
  expect(new URL(page.url()).searchParams.has("tab")).toBe(false);
});

test("unknown URL values select the first tab without treating a missing tab as allowed", async () => {
  await page.goto(`${server.resolvedUrls!.local[0]}tabs-test?tab=missing`);
  const tabs = page.getByRole("tablist", { name: "보기", exact: true });
  await element(tabs.getByRole("tab", { selected: true })).toHaveAccessibleName("조직도");
  await element(tabs.getByRole("tab")).toHaveCount(3);
  await element(page.locator('[data-tabs-demo="url"]').getByRole("tabpanel")).toContainText("조직도 보기입니다.");
});
