// SPDX-License-Identifier: LicenseRef-Proprietary
import { readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { expect as element } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { browserTestOptimizeDeps, chromium, type Browser, type Page } from "../../lib/browser-test";

let server: ViteDevServer;
let browser: Browser;
let page: Page;
beforeAll(async () => {
  server = await createServer({
    configFile: false, cacheDir: ".cache/top-bar-test", logLevel: "error",
    optimizeDeps: browserTestOptimizeDeps, resolve: { dedupe: ["react", "react-dom"] },
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, fs: { allow: [resolve("."), dirname(realpathSync("node_modules/pretendard"))] } },
    plugins: [{ name: "top-bar-test", resolveId: id => id === "/top-bar-test.js" ? "\0top-bar-test" : undefined,
      load: id => id === "\0top-bar-test" ? `
        import React, { useSyncExternalStore } from 'react';
        import { createRoot } from 'react-dom/client';
        import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
        import { i18n, loadCatalog } from '@console/i18n';
        import { TenantHead } from '/apps/web/src/shell/top-bar/tenant-head.tsx';
        import { AccountMenu } from '/apps/web/src/shell/top-bar/account-menu.tsx';
        import '/apps/web/src/app.css';
        await loadCatalog('ko');
        const tenant = { name: '이름이 아주 긴 고객 계정 이름 전체', phase: location.hash === '#operating' ? 'OPERATING' : 'SETUP', go_live_at: null };
        const root = createRootRoute({ component: () => React.createElement('main', null,
          React.createElement('header', { className: 'top' },
            React.createElement(TenantHead, { tenant }),
            React.createElement(AccountMenu, { id: 'test-account', name: '남궁가나다라마바사 전체 이름', onLogout: () => document.body.dataset.logout = 'yes' }))) });
        const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ['/'] }) });
        function App() {
          const locale = useSyncExternalStore(i18n.subscribe, () => i18n.locale);
          return React.createElement(RouterProvider, { router, key: locale });
        }
        createRoot(document.getElementById('root')).render(React.createElement(App));
      ` : undefined }],
  });
  await server.listen();
  browser = await chromium.launch();
  page = await browser.newPage();
  await page.route("**/top-bar-test", route => route.fulfill({ contentType: "text/html", body: '<html lang="ko"><title>Top bar</title><div id="root"></div><script type="module" src="/top-bar-test.js"></script></html>' }));
}, 60_000);
afterAll(async () => { await browser?.close(); await server?.close(); });

const open = async (hash = "") => {
  await page.goto("about:blank");
  await page.goto(`${server.resolvedUrls!.local[0]}top-bar-test${hash}`);
  await element(page.getByRole("button", { name: "남궁가나다라마바사 전체 이름", exact: true })).toBeVisible();
};

test.each([1440, 390])("menu disclosure is responsive at %spx", async width => {
  const css = readFileSync(resolve("packages/tokens/tokens.css"), "utf8") + readFileSync(resolve("apps/web/src/app.css"), "utf8").replace(/^@import .*;$/gm, "");
  await page.setViewportSize({ width, height: 900 });
  await page.setContent(`<style>${css}</style><header class="top"><button class="btn btn--ghost top__menu">메뉴</button></header>`);
  await element(page.getByRole("button", { name: "메뉴" })).toBeVisible({ visible: width === 390 });
});

test.each([390, 640, 641, 1440])("account trigger is icon-only through 640px, retaining its full name at %spx", async width => {
  await page.setViewportSize({ width, height: 900 });
  await open();
  const name = "남궁가나다라마바사 전체 이름";
  const trigger = page.getByRole("button", { name, exact: true });
  await element(trigger).toHaveAccessibleName(name);
  await element(trigger.locator("svg")).toBeVisible();
  await element(trigger.getByText(name, { exact: true })).toBeVisible({ visible: width > 640 });
});

test("tenant phase links home only during SETUP and preserves the full tenant name", async () => {
  await open();
  await element(page.getByTitle("이름이 아주 긴 고객 계정 이름 전체")).toHaveText("이름이 아주 긴 고객 계정 이름 전체");
  await element(page.getByRole("link", { name: "설정 단계", exact: true })).toHaveAttribute("href", "/");
  await open("#operating");
  await element(page.getByRole("link", { name: "설정 단계", exact: true })).toHaveCount(0);
});

test("account menu has exactly four entries, an account app link and logout action", async () => {
  await open();
  await page.getByRole("button", { name: "남궁가나다라마바사 전체 이름" }).click();
  expect(await page.getByRole("menuitem").allTextContents()).toEqual(["내 계정", "언어", "화면 테마", "로그아웃"]);
  await element(page.getByRole("menuitem", { name: "내 계정", exact: true })).toHaveAttribute("href", "/account");
  await page.getByRole("menuitem", { name: "로그아웃", exact: true }).click();
  await element(page.locator("body")).toHaveAttribute("data-logout", "yes");
});

test("language radios switch locale and restore focus after the locale remount", async () => {
  await open();
  await page.getByRole("button", { name: "남궁가나다라마바사 전체 이름" }).click();
  await page.getByRole("menuitem", { name: "언어", exact: true }).press("ArrowRight");
  await element(page.getByRole("menuitemradio", { name: "한국어", exact: true })).toHaveAttribute("aria-checked", "true");
  await page.getByRole("menuitemradio", { name: "English", exact: true }).click();
  await element(page.locator("html")).toHaveAttribute("lang", "en");
  await element(page.getByRole("button", { name: "남궁가나다라마바사 전체 이름" })).toBeFocused();
  await page.getByRole("button", { name: "남궁가나다라마바사 전체 이름" }).press("Enter");
  await page.getByRole("menuitem", { name: "Language", exact: true }).press("ArrowRight");
  await element(page.getByRole("menuitemradio", { name: "English", exact: true })).toHaveAttribute("aria-checked", "true");
});

test.each(["dark", "light"])("theme radio selects %s on the document", async theme => {
  await open();
  await page.getByRole("button", { name: "남궁가나다라마바사 전체 이름" }).click();
  await page.getByRole("menuitem", { name: "화면 테마", exact: true }).press("ArrowRight");
  await page.getByRole("menuitemradio", { name: theme === "dark" ? "어두운 화면" : "밝은 화면", exact: true }).click();
  await element(page.locator("html")).toHaveAttribute("data-theme", theme);
  await element(page.getByRole("button", { name: "남궁가나다라마바사 전체 이름" })).toBeFocused();
});
