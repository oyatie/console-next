// SPDX-License-Identifier: LicenseRef-Proprietary
import { readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { expect as element } from "@playwright/test";
import { createServer, preprocessCSS, type ViteDevServer } from "vite";
import { browserTestOptimizeDeps, chromium, type Browser, type Page } from "../../lib/browser-test";
import { breakpoints } from "../../ui/breakpoints";

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
        import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
        import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
        import { i18n, loadCatalog } from '@console/i18n';
        import { setLocale } from '/apps/web/src/shell/locale.ts';
        import { TenantHead } from '/apps/web/src/shell/top-bar/tenant-head.tsx';
        import { NeedsMeMenu } from '/apps/web/src/shell/top-bar/needs-me.tsx';
        import { AccountMenu } from '/apps/web/src/shell/top-bar/account-menu.tsx';
        import '/apps/web/src/app.css';
        await loadCatalog('ko');
        await setLocale('ko');
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        const tenant = { name: '이름이 아주 긴 고객 계정 이름 전체', phase: location.hash === '#operating' ? 'OPERATING' : 'SETUP', go_live_at: null };
        const root = createRootRoute({ component: () => React.createElement('main', null,
          React.createElement('header', { className: 'top' },
            React.createElement(TenantHead, { tenant }),
            React.createElement(NeedsMeMenu, { id: 'test-needs-me' }),
            React.createElement(AccountMenu, { id: 'test-account', name: '남궁가나다라마바사 전체 이름', onLogout: () => document.body.dataset.logout = 'yes' }))) });
        const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ['/'] }) });
        function App() {
          const locale = useSyncExternalStore(i18n.subscribe, () => i18n.locale);
          return React.createElement(QueryClientProvider, { client }, React.createElement(RouterProvider, { router, key: locale }));
        }
        createRoot(document.getElementById('root')).render(React.createElement(App));
      ` : undefined }],
  });
  await server.listen();
  browser = await chromium.launch();
  page = await browser.newPage();
  await page.route("**/api/v1/me/action-inbox**", route => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      as_of: "2026-11-04T09:00:00Z",
      has_work: true,
      available_filters: ["turn"],
      counts: { turn: { total: 3, total_is_exact: true } },
      unavailable: [],
      next_cursor: null,
      items: [
        { id: "task-1", kind: "org_change_approve", title: "인사팀 신설 승인", due: "2026-11-06T09:00:00Z", days_remaining: 2, dueTone: "warn", links: [{ kind: "org_change", id: "00000000-0000-4000-8000-000000000001" }] },
        { id: "task-2", kind: "contract_renewal", title: "김민수 근로계약 갱신", due: null, days_remaining: null, links: [{ kind: "employee", id: "00000000-0000-4000-8000-000000000002" }] },
      ],
    }),
  }));
  await page.route("**/top-bar-test", route => route.fulfill({ contentType: "text/html", body: '<html lang="ko"><title>Top bar</title><div id="root"></div><script type="module" src="/top-bar-test.js"></script></html>' }));
}, 60_000);
afterAll(async () => { await browser?.close(); await server?.close(); });

const open = async (hash = "") => {
  await page.goto("about:blank");
  await page.goto(`${server.resolvedUrls!.local[0]}top-bar-test${hash}`);
  await element(page.getByRole("button", { name: "남궁가나다라마바사 전체 이름", exact: true })).toBeVisible();
};

test.each([1440, breakpoints.md, breakpoints.md - 1, 390])("menu disclosure is responsive at %spx", async width => {
  const css = readFileSync(resolve("packages/tokens/tokens.css"), "utf8") + readFileSync(resolve("apps/web/src/app.css"), "utf8").replace(/^@import .*;$/gm, "");
  const compiled = await preprocessCSS(css, resolve("apps/web/src/app.css"), server.config);
  await page.setViewportSize({ width, height: 900 });
  await page.setContent(`<style>${compiled.code}</style><header class="top"><button class="btn btn--ghost top__menu">메뉴</button></header>`);
  await element(page.getByRole("button", { name: "메뉴" })).toBeVisible({ visible: width < breakpoints.md });
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

test("account menu includes the self-service rights path and logout action", async () => {
  await open();
  await page.getByRole("button", { name: "남궁가나다라마바사 전체 이름" }).click();
  expect(await page.getByRole("menuitem").allTextContents()).toEqual(["내 계정", "개인정보 권리 행사", "언어", "화면 테마", "로그아웃"]);
  await element(page.getByRole("menuitem", { name: "내 계정", exact: true })).toHaveAttribute("href", "/account");
  await element(page.getByRole("menuitem", { name: "개인정보 권리 행사", exact: true })).toHaveAttribute("href", "/account/privacy");
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

test.each([1440, 390])("needs-me badge shows turn count, opens task panel with /inbox link, and closes on Escape at %spx", async width => {
  await page.setViewportSize({ width, height: 900 });
  await open();
  const trigger = page.getByRole("button", { name: "대기 업무 3건", exact: true });
  await element(trigger).toBeVisible();
  await element(trigger.locator("[data-count]")).toHaveText("3");
  await element(trigger.getByText("업무함", { exact: true })).toBeVisible({ visible: width > 640 });
  expect(await page.evaluate(() => document.scrollingElement!.scrollWidth <= innerWidth)).toBe(true);

  await trigger.click();
  const panel = page.getByRole("dialog", { name: "대기 업무", exact: true });
  await element(panel).toBeVisible();
  await element(panel.getByRole("link", { name: "업무함에서 모두 보기", exact: true })).toHaveAttribute("href", "/inbox");
  await element(panel.getByRole("link", { name: /인사팀 신설 승인/ })).toHaveAttribute("href", "/org/changes/00000000-0000-4000-8000-000000000001");
  await page.keyboard.press("Escape");
  await element(panel).toHaveCount(0);
  await element(trigger).toBeFocused();
});

test("needs-me badge omits count pill when 0 items need action and renders empty state", async () => {
  await page.route("**/api/v1/me/action-inbox**", route => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ as_of: "2026-11-04T09:00:00Z", has_work: false, available_filters: [], counts: { turn: { total: 0, total_is_exact: true } }, unavailable: [], next_cursor: null, items: [] }),
  }));
  await open();
  const trigger = page.getByRole("button", { name: "대기 업무", exact: true });
  await element(trigger).toBeVisible();
  await element(trigger.locator("[data-count]")).toHaveCount(0);
  await trigger.click();
  await element(page.getByRole("dialog", { name: "대기 업무", exact: true }).getByText("처리할 업무가 없습니다", { exact: true })).toBeVisible();
});
