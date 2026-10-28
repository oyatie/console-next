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
  // A pending image must not hold up assertions about the rendered view or history.
  await page.route("**/tabs-history-pending.svg", () => {});
  await page.route(/\/tabs-test(?:\?.*)?$/, route => {
    const params = new URL(route.request().url()).searchParams;
    const pending = params.get("scope") === "previous" || params.get("tab") === "outline" ? '<img src="/tabs-history-pending.svg" alt="">' : "";
    return route.fulfill({ contentType: "text/html", body: `<html lang="ko"><title>Tabs</title><main id="root"></main><script type="module" src="/tabs-test.js"></script>${pending}</html>` });
  });
}, 60_000);
afterAll(async () => { await browser?.close(); await server?.close(); });

test.each([1440, 390, 320])("URL views are links and keep their content outside the shared head at %spx", async width => {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`${server.resolvedUrls!.local[0]}tabs-test`);
  const tabs = page.getByRole("navigation", { name: "보기", exact: true });
  await element(page.locator("header").getByRole("navigation")).toBeVisible();
  const link = tabs.getByRole("link", { name: "목록 61", exact: true });
  if (!await link.isVisible()) await tabs.getByRole("button", { name: "더 보기", exact: true }).click();
  await page.getByRole("link", { name: "목록 61", exact: true }).first().click();
  await element(tabs.locator('[aria-current="page"]')).toHaveAccessibleName("목록 61");
  const panel = page.locator('[data-tabs-demo="url"] [data-page-view]');
  await element(panel).toHaveText("목록 보기입니다.");
  expect(await panel.evaluate(el => Boolean(el.closest("header")))).toBe(false);
  await element(tabs.getByRole("tab")).toHaveCount(0);
  expect(await page.evaluate(() => document.scrollingElement!.scrollWidth - innerWidth)).toBe(0);
});

test("URL links replace history, restore deep links and preserve other filters", async () => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${server.resolvedUrls!.local[0]}tabs-test?scope=previous`, { waitUntil: "commit" });
  const tabs = page.getByRole("navigation", { name: "보기", exact: true });
  await element(tabs.locator('[aria-current="page"]')).toHaveAccessibleName("조직도");
  await page.goto(`${server.resolvedUrls!.local[0]}tabs-test?tab=list&scope=workplace#record`, { waitUntil: "commit" });
  await element(tabs.locator('[aria-current="page"]')).toHaveAccessibleName("목록 61");
  const length = await page.evaluate(() => history.length);
  const outline = tabs.getByRole("link", { name: "아웃라인", exact: true });
  expect(new URL((await outline.getAttribute("href"))!, page.url()).searchParams.get("tab")).toBe("outline");
  await outline.click();
  await element(page).toHaveURL(/tab=outline.*scope=workplace#record$/);
  await page.reload({ waitUntil: "commit" });
  await element(tabs.locator('[aria-current="page"]')).toHaveAccessibleName("아웃라인");
  expect(await page.evaluate(() => history.length)).toBe(length);
  await tabs.getByRole("link", { name: "조직도", exact: true }).click();
  await element(page).toHaveURL(/scope=workplace#record$/);
  expect(new URL(page.url()).searchParams.has("tab")).toBe(false);
  await page.goBack({ waitUntil: "commit" });
  await element(page).toHaveURL(/scope=previous$/);
  await element(tabs.locator('[aria-current="page"]')).toHaveAccessibleName("조직도");
  await page.goForward({ waitUntil: "commit" });
  await element(page).toHaveURL(/scope=workplace#record$/);
  await element(tabs.locator('[aria-current="page"]')).toHaveAccessibleName("조직도");
});

test("unknown URL values select the first tab without treating a missing tab as allowed", async () => {
  await page.goto(`${server.resolvedUrls!.local[0]}tabs-test?tab=missing`);
  const tabs = page.getByRole("navigation", { name: "보기", exact: true });
  await element(tabs.locator('[aria-current="page"]')).toHaveAccessibleName("조직도");
  await element(tabs.getByRole("link")).toHaveCount(3);
  await tabs.getByRole("link", { name: "조직도", exact: true }).click();
  await element(page).toHaveURL(/tabs-test$/);
  await element(page.locator('[data-tabs-demo="url"] [data-page-view]')).toContainText("조직도 보기입니다.");
});

test("temporarily unavailable views remain focusable with a reason and cannot navigate", async () => {
  await page.goto(`${server.resolvedUrls!.local[0]}tabs-test?tab=unavailable`);
  const demo = page.locator('[data-tabs-demo="unavailable"]');
  const unavailable = demo.getByRole("link", { name: "아웃라인", exact: true });
  await element(unavailable).toHaveAttribute("aria-disabled", "true");
  await page.mouse.move(0, 0);
  expect(await demo.getByRole("navigation").evaluate(el => el.getBoundingClientRect().height)).toBeLessThanOrEqual(56);
  await unavailable.focus();
  await element(unavailable).toBeFocused();
  await element(unavailable).toHaveAccessibleDescription("먼저 설정을 완료합니다");
  await unavailable.press("Enter");
  await unavailable.click({ force: true });
  await element(page).toHaveURL(/tab=unavailable$/);
  await element(demo.locator('[aria-current="page"]')).toHaveAccessibleName("목록");
  await element(demo.locator('[data-page-view]')).toHaveText("목록 보기입니다.");
  expect(await unavailable.getAttribute("href")).toBeNull();
});

test("long URL views overflow into more, keep the selection visible and resize without scrolling", async () => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto(`${server.resolvedUrls!.local[0]}tabs-test?scope=workplace#record`);
  const demo = page.locator('[data-tabs-demo="long"]');
  const row = demo.getByRole("navigation");
  expect(await row.getByRole("button", { name: "더 보기", exact: true }).evaluate(el => {
    const range = document.createRange();
    range.selectNodeContents(el);
    return range.getClientRects().length;
  })).toBe(1);
  await row.getByRole("button", { name: "더 보기", exact: true }).click();
  const popup = page.getByRole("dialog", { name: "더 보기", exact: true });
  const last = popup.getByRole("link").last();
  const label = await last.textContent();
  await last.press("Enter");
  await element(popup).toBeHidden();
  await element(row.locator('[aria-current="page"]')).toHaveText(label!);
  await element(page).toHaveURL(/scope=workplace.*tab=long-7#record$/);
  for (const width of [320, 1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await element(row.locator('[aria-current="page"]')).toBeVisible();
    expect(await row.evaluate(el => el.scrollWidth - el.clientWidth)).toBe(0);
    expect(await row.evaluate(el => el.getBoundingClientRect().height)).toBeLessThanOrEqual(56);
    expect(await page.evaluate(() => document.scrollingElement!.scrollWidth - innerWidth)).toBe(0);
  }
});
