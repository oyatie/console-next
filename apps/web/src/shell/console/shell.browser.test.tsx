// SPDX-License-Identifier: LicenseRef-Proprietary
import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import type { Locator } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { browserEngine, browserTestOptimizeDeps, openBrowserTestPage, type Browser, type BrowserContext, type Page } from "../../lib/browser-test";
import { contrastRatio } from "../../../../../scripts/check-contrast.mjs";

let server: ViteDevServer;
let browser: Browser;
let context: BrowserContext;
let page: Page;

// Axe does not measure a background image, so the select's chevron (its only dropdown cue) is measured here.
async function chevronContrast(select: Locator) {
  const { image, background } = await select.evaluate(el => {
    const style = getComputedStyle(el);
    return { image: style.backgroundImage, background: style.backgroundColor };
  });
  const stroke = image.match(/stroke='%23([\da-f]{6})'/i)?.[1];
  const rgb = background.match(/^rgb\((\d+), (\d+), (\d+)\)$/)?.slice(1);
  expect(stroke, image).toBeTruthy();
  expect(rgb, background).toBeTruthy();
  return contrastRatio(`#${stroke}`, `#${rgb!.map(v => Number(v).toString(16).padStart(2, "0")).join("")}`);
}

beforeAll(async () => {
  await loadCatalog("ko");
  server = await createServer({
    configFile: false,
    cacheDir: ".cache/console-shell-shortcut-test",
    logLevel: "error",
    optimizeDeps: browserTestOptimizeDeps,
    resolve: { dedupe: ["react", "react-dom"] },
    server: {
      host: "127.0.0.1",
      port: 0,
      watch: null,
      hmr: false,
      fs: { allow: [resolve("."), dirname(realpathSync("node_modules/pretendard"))] },
    },
    plugins: [{
      name: "console-shell-shortcut-test",
      resolveId: id => id === "/console-shell-shortcut-test.js" ? "\0console-shell-shortcut-test" : undefined,
      load: id => id === "\0console-shell-shortcut-test" ? `
        import React, { useEffect, useState } from 'react';
        import { createRoot } from 'react-dom/client';
        import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider, useLocation, useNavigate } from '@tanstack/react-router';
        import { loadCatalog } from '@console/i18n';
        import { ConsoleAccountMenu } from '/apps/web/src/shell/console/console-account-menu.tsx';
        import { canonicalTabTarget } from '/apps/web/src/shell/console/tab-titles.ts';
        import { useWorkspaceTabs } from '/apps/web/src/shell/console/workspace-tabs-state.ts';
        import { openWorkspaceTab, resolveAppHref } from '/apps/web/src/ui/workspace-tabs/open-tab.ts';
        import { singleKeysOn } from '/apps/web/src/lib/prefs.ts';
        import { isImeKey } from '/apps/web/src/lib/pure/ime.ts';
        import { singleKey } from '/apps/web/src/lib/pure/keys.ts';
        import { editable } from '/apps/web/src/ui/long-table/row-keys.ts';
        import '/apps/web/src/app.css';
        await loadCatalog('ko');
        function Harness() {
          const { pathname, searchStr = '', href } = useLocation();
          const navigate = useNavigate();
          const [withFind, setWithFind] = useState(false);
          const [searchOpens, setSearchOpens] = useState(0);
          const tabTarget = canonicalTabTarget(pathname, searchStr);
          const tabs = useWorkspaceTabs({
            principal: 'test-user',
            defaultHref: '/',
            defaultLabel: 'Home',
            pathname: tabTarget,
            currentHref: href,
            pathLabel: pathname === '/inbox' ? 'Inbox' : pathname === '/org' ? 'Org' : 'Home',
            onNavigate: nextHref => {
              const resolved = resolveAppHref(nextHref, pathname);
              if (resolved) void navigate({ href: resolved });
            },
          });
          useEffect(() => {
            window.__openTab = openWorkspaceTab;
          }, []);
          useEffect(() => {
            const onKeyDown = event => {
              if (event.defaultPrevented || isImeKey(event)) return;
              if (!singleKey(event) || event.key !== '/') return;
              if (!singleKeysOn() || editable(event.target)) return;
              if (document.querySelector('[role=dialog], [role=alertdialog]') !== null) return;
              event.preventDefault();
              const mainEl = document.getElementById('main');
              const inPageFind = mainEl?.querySelector('[data-list-find] input, input[type="search"]');
              if (inPageFind && inPageFind.offsetParent !== null) {
                inPageFind.focus();
                return;
              }
              setSearchOpens(n => n + 1);
            };
            document.addEventListener('keydown', onKeyDown);
            return () => document.removeEventListener('keydown', onKeyDown);
          }, []);
          return React.createElement(
            React.Fragment,
            null,
            React.createElement('header', { 'data-surface': 'chrome' }, React.createElement(ConsoleAccountMenu, { id: 'console-top-account', name: 'Console Operator' })),
            React.createElement('main', { id: 'main', 'data-shell-harness': '' },
              React.createElement('output', { 'data-opens': '' }, String(searchOpens)),
              React.createElement('output', { 'data-href': '' }, href),
              React.createElement('output', { 'data-tabs': '' }, JSON.stringify(tabs.tabs.map(t => t.href))),
              React.createElement('button', { type: 'button', onClick: () => setWithFind(v => !v) }, 'toggle'),
              React.createElement('button', { type: 'button', onClick: () => void navigate({ href: '/inbox' }) }, 'go-inbox'),
              React.createElement('button', { type: 'button', onClick: () => void navigate({ href: '/org' }) }, 'go-org'),
              React.createElement('input', { 'aria-label': 'plain' }),
              withFind ? React.createElement('div', { 'data-list-find': '' }, React.createElement('input', { type: 'search', 'aria-label': 'find' })) : null,
            ),
          );
        }
        const root = createRootRoute();
        const indexRoute = createRoute({ getParentRoute: () => root, path: '/', component: Harness });
        const inboxRoute = createRoute({ getParentRoute: () => root, path: '/inbox', component: Harness });
        const orgRoute = createRoute({ getParentRoute: () => root, path: '/org', component: Harness });
        const accountRoute = createRoute({ getParentRoute: () => root, path: '/account', component: () => null });
        const privacyRoute = createRoute({ getParentRoute: () => root, path: '/account/privacy', component: () => null });
        const router = createRouter({
          routeTree: root.addChildren([indexRoute, inboxRoute, orgRoute, accountRoute, privacyRoute]),
          history: createMemoryHistory({ initialEntries: ['/'] }),
        });
        createRoot(document.getElementById('root')).render(React.createElement(RouterProvider, { router }));
      ` : undefined,
    }],
  });
  await server.listen();
  browser = await browserEngine().launch();
  context = await browser.newContext();
  page = await context.newPage();
  await page.route("**/console-shell-shortcut-test", route => route.fulfill({
    contentType: "text/html",
    body: '<html lang="ko" data-experience="console"><title>Console Shell</title><div id="root"></div><script type="module" src="/console-shell-shortcut-test.js"></script></html>',
  }));
  await openBrowserTestPage(page, `${server.resolvedUrls!.local[0]}console-shell-shortcut-test`, page.locator("[data-shell-harness]"));
}, 60_000);

afterAll(async () => {
  await page?.close();
  await context?.close();
  await browser?.close();
  await server?.close();
});

test("slash shortcut opens search, yields to in-page find, and respects singleKeysOn and input focus", async () => {
  expect(t("shell.scope.allEntities")).toBeTruthy();

  await page.keyboard.press("/");
  await expect.poll(async () => await page.locator("[data-opens]").textContent()).toBe("1");

  // Inside an input, `/` types into the input rather than opening global search.
  const plainInput = page.getByLabel("plain");
  await plainInput.focus();
  await page.keyboard.press("/");
  await expect.poll(async () => await page.locator("[data-opens]").textContent()).toBe("1");

  // With an in-page find field visible, `/` focuses that find field instead of opening global search.
  await page.getByRole("button", { name: "toggle" }).click();
  await page.getByRole("button", { name: "toggle" }).focus();
  await page.keyboard.press("/");
  await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("find");
  await expect.poll(async () => await page.locator("[data-opens]").textContent()).toBe("1");

  // With single-key shortcuts disabled on the device ("off"), `/` does not act.
  await page.evaluate(() => localStorage.setItem("console.singleKeys", "off"));
  await page.getByRole("button", { name: "toggle" }).click();
  await page.getByRole("button", { name: "toggle" }).focus();
  await page.keyboard.press("/");
  await expect.poll(async () => await page.locator("[data-opens]").textContent()).toBe("1");
});

test("ConsoleAccountMenu holds the shared language, theme and sign-out controls by their shared names and closes on Escape", async () => {
  await page.evaluate(() => localStorage.setItem("console.theme", "light"));
  const trigger = page.getByRole("button", { name: "Console Operator", exact: true });
  await trigger.click();

  const group = page.getByRole("group", { name: t("shell.account"), exact: true });
  await group.waitFor();
  const language = group.getByRole("combobox", { name: t("shell.locale"), exact: true });
  await expect.poll(() => language.locator("option").allTextContents()).toEqual([t("shell.locale.ko"), t("shell.locale.en")]);
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe("light");
  expect(await chevronContrast(language)).toBeGreaterThanOrEqual(3);
  expect(await group.getByRole("button", { name: t("shell.logout"), exact: true }).isVisible()).toBe(true);

  // The theme control is the one Classic's bar has, named for the theme it turns to.
  await group.getByRole("button", { name: t("shell.theme.toDark"), exact: true }).click();
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe("dark");
  await trigger.click();
  expect(await chevronContrast(language)).toBeGreaterThanOrEqual(3);
  await group.getByRole("button", { name: t("shell.theme.toLight"), exact: true }).click();
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe("light");

  // Escape closes the menu from its trigger or from any control in it, and is the menu's alone: no listener above hears it.
  await page.evaluate(() => {
    const seen = window as unknown as { escapes: number };
    seen.escapes = 0;
    document.addEventListener("keydown", event => { if (event.key === "Escape") seen.escapes++; });
  });
  await trigger.click();
  await trigger.focus();
  await page.keyboard.press("Escape");
  await expect.poll(async () => await group.count()).toBe(0);
  await trigger.click();
  await language.focus();
  await page.keyboard.press("Escape");
  await expect.poll(async () => await group.count()).toBe(0);
  await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe("console-top-account");
  expect(await page.evaluate(() => (window as unknown as { escapes: number }).escapes)).toBe(0);
});

test("openWorkspaceTab resolves query-only href against current pathname and rejects external/protocol-relative URLs", async () => {
  await page.getByRole("button", { name: "go-inbox", exact: true }).click();
  await expect.poll(async () => await page.locator("[data-href]").textContent()).toBe("/inbox");

  await page.evaluate(() => {
    const open = (window as unknown as { __openTab: (p: { href: string; label: string }) => void }).__openTab;
    open({ href: "https://evil.example/phish", label: "Evil" });
    open({ href: "//evil.example/phish", label: "ProtoRel" });
    open({ href: "?sel=from-inbox", label: "Selected" });
  });

  await expect.poll(async () => await page.locator("[data-href]").textContent()).toBe("/inbox?sel=from-inbox");
  const tabHrefs = JSON.parse((await page.locator("[data-tabs]").textContent()) ?? "[]") as string[];
  expect(tabHrefs).toContain("/inbox?sel=from-inbox");
  expect(tabHrefs).not.toContain("https://evil.example/phish");
  expect(tabHrefs).not.toContain("//evil.example/phish");
});

test("openWorkspaceTab preserves hash fragments on view-query routes when reconciled with canonicalTabTarget", async () => {
  await page.evaluate(() => {
    const open = (window as unknown as { __openTab: (p: { href: string; label: string }) => void }).__openTab;
    open({ href: "/org?tab=entities#identifier-corrections", label: "Entities" });
  });

  await expect.poll(async () => await page.locator("[data-href]").textContent()).toBe("/org?tab=entities#identifier-corrections");
  await expect.poll(async () => {
    const hrefs = JSON.parse((await page.locator("[data-tabs]").textContent()) ?? "[]") as string[];
    return hrefs.includes("/org?tab=entities#identifier-corrections");
  }).toBe(true);

  await page.getByRole("button", { name: "go-org", exact: true }).click();
  await expect.poll(async () => await page.locator("[data-href]").textContent()).toBe("/org");
  const afterChart = JSON.parse((await page.locator("[data-tabs]").textContent()) ?? "[]") as string[];
  expect(afterChart).toContain("/org");
  expect(afterChart).not.toContain("/org?tab=entities#identifier-corrections");
});
