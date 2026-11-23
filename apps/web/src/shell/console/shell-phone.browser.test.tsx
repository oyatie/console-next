// SPDX-License-Identifier: LicenseRef-Proprietary
import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import { loadCatalog, t } from "@console/i18n";
import { browserEngine, browserTestOptimizeDeps, openBrowserTestPage, type Browser, type Page } from "../../lib/browser-test";

let server: ViteDevServer;
let browser: Browser;
let page: Page;

beforeAll(async () => {
  await loadCatalog("ko");
  server = await createServer({
    configFile: false,
    cacheDir: ".cache/console-phone-shell-test",
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
      name: "console-phone-nav-test",
      resolveId: id => id === "/console-phone-nav-test.js" ? "\0console-phone-nav-test" : undefined,
      load: id => id === "\0console-phone-nav-test" ? `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
        import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider, useLocation, useNavigate, useRouter } from '@tanstack/react-router';
        import { session } from '@console/api';
        import { useSidePanel } from '/apps/web/src/lib/side-panel/use-side-panel.ts';
        import { loadCatalog } from '@console/i18n';
        import { ConsoleShell } from '/apps/web/src/shell/console/shell.tsx';
        import '/apps/web/src/app.css';
        await loadCatalog('ko');
        session.set({
          access_token: 'h.' + btoa(JSON.stringify({ sub: 'hero', org: 'tenant', name: 'Hajun' })).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '') + '.s',
          token_type: 'Bearer', refresh_expires_at: '2099-01-01T00:00:00Z', requires_passkey_setup: false,
        });
        const h = React.createElement;
        const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        function Screen({ title }) {
          const navigate = useNavigate();
          const router = useRouter();
          const sheet = useSidePanel('sheet');
          const entry = useLocation({ select: location => location.state.__TSR_index });
          return h('div', { 'data-phone-screen': title, 'data-entry': entry, 'data-sheet': sheet.selected ?? '' },
            h('h1', null, title),
            h('button', { type: 'button', onClick: () => void navigate({ href: '/account?sheet=certificates' }) }, 'go-certificates'),
            h('button', { type: 'button', onClick: () => void navigate({ href: '/account' }) }, 'go-account'),
            h('button', { type: 'button', onClick: () => sheet.close() }, 'close-sheet'),
            h('button', { type: 'button', onClick: () => router.history.back() }, 'go-back'),
          );
        }
        // The frame's skip link comes before the shell, as ShellFrame draws it.
        const root = createRootRoute({ component: () => h(React.Fragment, null, h('a', { className: 'skip', href: '#main' }, 'skip'), h(ConsoleShell)) });
        const mk = (path, title) => createRoute({ getParentRoute: () => root, path, staticData: { access: 'signed-in' }, component: () => h(Screen, { title }) });
        const router = createRouter({
          routeTree: root.addChildren([mk('/', 'Home'), mk('/account', 'Account'), mk('/leave', 'Leave'), mk('/payslips', 'Payslips')]),
          history: createMemoryHistory({ initialEntries: ['/account'] }),
        });
        createRoot(document.getElementById('root')).render(h(QueryClientProvider, { client: qc }, h(RouterProvider, { router })));
      ` : undefined,
    }],
  });
  await server.listen();
  browser = await browserEngine().launch();
  page = await browser.newPage();
}, 60_000);

afterAll(async () => {
  await page?.close();
  await browser?.close();
  await server?.close();
});

async function openPhoneShell(link: "LINKED" | "UNLINKED" = "LINKED") {
  const apiMocks: Record<string, unknown> = {
    "/api/v1/users/me": {
      id: "u1", display_name: "Hajun", employee_name: "Hajun", employee_id: link === "LINKED" ? "e1" : null,
      employee_link_status: link, employee_company: "Saeon", tenant: { name: "Saeon", phase: "OPERATING" },
    },
    "/api/v1/me/authz": { capabilities: [] },
    "/api/v1/access/me": { is_ops: false, entries: [], phase: "OPERATING" },
    "/api/v1/support-sessions/active": { can_approve: false, sessions: [], pending_count: 0 },
    "/api/v1/onboarding/modules": ["home", "people"].map(key => ({ key, ready: true, unblock: null })),
    "/api/v1/onboarding/checklist": { phase: "OPERATING", steps: [] },
    "/api/v1/me/action-inbox": { items: [], next_cursor: null, counts: { turn: { total: 0, total_is_exact: true } }, attention_filters: [] },
    "/api/v1/auth/passkeys": [],
  };
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/console-phone-nav-test", route => route.fulfill({
    contentType: "text/html",
    body: '<html lang="ko" data-experience="console"><title>Console Phone</title><div id="root"></div><script type="module" src="/console-phone-nav-test.js"></script></html>',
  }));
  await page.route("**/api/v1/**", route => {
    const path = new URL(route.request().url()).pathname;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(apiMocks[path] ?? { items: [] }) });
  });

  await openBrowserTestPage(page, `${server.resolvedUrls!.local[0]}console-phone-nav-test`, page.locator('[data-phone-screen="Account"]'));
  const nav = page.getByRole("navigation", { name: t("shell.nav"), exact: true });
  await nav.waitFor();
  return nav;
}

const screenEntry = async () => Number(await page.locator("[data-phone-screen]").getAttribute("data-entry"));

test("the self-service certificates tab opens the employee's own certificates, and closing it leaves no extra Back", async () => {
  const nav = await openPhoneShell();
  const expectCurrent = async (href: string, label: string) => {
    await expect.poll(async () => await nav.locator('a[aria-current="page"]').count()).toBe(1);
    await expect.poll(async () => await nav.locator('a[aria-current="page"]').getAttribute("href")).toBe(href);
    await expect.poll(async () => (await nav.locator('a[aria-current="page"]').textContent())?.trim()).toBe(label);
  };
  const tab = nav.getByRole("link", { name: t("shell.link.certificates"), exact: true });

  // An employee on the self-service nav holds no HR grant, so the HR certificate list would only refuse them.
  expect(await tab.getAttribute("href")).toBe("/account?sheet=certificates");
  await expectCurrent("/account", t("shell.link.profile"));
  const first = await screenEntry();

  await tab.click();
  await expectCurrent("/account?sheet=certificates", t("shell.link.certificates"));
  await expect.poll(() => page.locator('[data-phone-screen="Account"]').getAttribute("data-sheet")).toBe("certificates");
  expect(await screenEntry()).toBe(first + 1);

  // Closing a sheet the tab opened unwinds the entry the tab pushed: the next Back leaves /account, not reopens it.
  await page.getByRole("button", { name: "close-sheet", exact: true }).click();
  await expectCurrent("/account", t("shell.link.profile"));
  expect(await screenEntry()).toBe(first);

  // Back from an open sheet closes it.
  await tab.click();
  await expectCurrent("/account?sheet=certificates", t("shell.link.certificates"));
  await page.getByRole("button", { name: "go-back", exact: true }).click();
  await expectCurrent("/account", t("shell.link.profile"));
  expect(await screenEntry()).toBe(first);

  await page.getByRole("button", { name: "go-certificates", exact: true }).click();
  await expectCurrent("/account?sheet=certificates", t("shell.link.certificates"));
});

test("an account with no employee record has no certificates tab, since it holds no certificates of its own", async () => {
  const nav = await openPhoneShell("UNLINKED");
  await expect.poll(async () => await nav.getByRole("link", { name: t("shell.link.profile"), exact: true }).count()).toBe(1);
  expect(await nav.getByRole("link", { name: t("shell.link.certificates"), exact: true }).count()).toBe(0);
});

/** Appends `html` to the phone screen and returns each `[data-probe]` element's page offset. */
async function grow(html: string) {
  return page.evaluate(markup => {
    document.querySelector("[data-phone-screen]")!.insertAdjacentHTML("beforeend", markup);
    return Object.fromEntries([...document.querySelectorAll<HTMLElement>("[data-probe]")]
      .map(element => [element.dataset.probe!, element.getBoundingClientRect().top + window.scrollY]));
  }, html);
}
const hitIn = (x: number, y: number, selector: string) =>
  page.evaluate(([px, py, sel]) => Boolean(document.elementFromPoint(px, py)?.closest(sel)), [x, y, selector] as const);

test("on a phone the top bar and bottom nav stay on screen while a long page scrolls, and focus stops clear of both", async () => {
  const nav = await openPhoneShell();
  const at = await grow('<div style="block-size: 1200px"></div><button data-probe="near-top">near top</button><div style="block-size: 1800px"></div><button data-probe="near-nav">near nav</button><div style="block-size: 1200px"></div>');
  await page.evaluate(() => window.scrollTo(0, 1200));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(1200);

  const navBox = (await nav.boundingBox())!;
  const topBox = (await page.locator('header[data-surface="chrome"]').boundingBox())!;
  expect(Math.round(navBox.y + navBox.height)).toBe(844);
  expect(topBox.y).toBe(0);

  // A control half under the top bar, then one half under the nav: focusing each brings it clear of the bar.
  const nearTop = page.getByRole("button", { name: "near top", exact: true });
  const nearNav = page.getByRole("button", { name: "near nav", exact: true });
  await page.evaluate(y => window.scrollTo(0, y), at["near-top"]! - topBox.height / 2);
  await nearTop.focus();
  expect((await nearTop.boundingBox())!.y).toBeGreaterThanOrEqual(topBox.y + topBox.height - 0.5);
  await nearTop.blur();
  await page.evaluate(y => window.scrollTo(0, y), at["near-nav"]! - navBox.y);
  await nearNav.focus();
  const nearNavBox = (await nearNav.boundingBox())!;
  expect(nearNavBox.y + nearNavBox.height).toBeLessThanOrEqual(navBox.y + 0.5);
});

test("on a phone the page's last control scrolls fully clear of both bars, so nothing stays under one", async () => {
  const nav = await openPhoneShell();
  await grow('<div style="block-size: 2400px"></div><button data-probe="last">last</button>');
  await page.evaluate(() => window.scrollTo(0, document.scrollingElement!.scrollHeight));
  const last = page.locator("#main").locator("a[href], button, input, select, textarea, [tabindex]").last();
  await expect.poll(async () => await last.textContent()).toBe("last");
  const [box, topBox, navBox] = [(await last.boundingBox())!, (await page.locator('header[data-surface="chrome"]').boundingBox())!, (await nav.boundingBox())!];
  expect(box.y).toBeGreaterThanOrEqual(topBox.y + topBox.height - 0.5);
  expect(box.y + box.height).toBeLessThanOrEqual(navBox.y + 0.5);
});

test("on a phone the bars draw over the page's own raised layers, the skip link draws over the bars, and the account menu over the page", async () => {
  const nav = await openPhoneShell();
  // A record's section strip (z-index 4) and a sticky action bar (z-index 5), as the page draws them.
  const at = await grow('<div data-probe="strip" data-page-layer style="position: sticky; top: 0; z-index: 4; block-size: 400px; background: red"></div><div style="block-size: 2000px"></div><div data-probe="bar" data-page-layer style="position: sticky; bottom: 0; z-index: 5; block-size: 160px; background: red"></div><div style="block-size: 600px"></div>');
  const header = page.locator('header[data-surface="chrome"]');

  // At the top of the page the account menu opens over the strip.
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.locator("#console-phone-account").click();
  const menu = page.getByRole("group", { name: t("shell.account"), exact: true });
  const menuBox = (await menu.boundingBox())!;
  expect(await hitIn(menuBox.x + menuBox.width / 2, menuBox.y + menuBox.height / 2, '[role="group"]')).toBe(true);
  await page.keyboard.press("Escape");
  await expect.poll(async () => await menu.count()).toBe(0);

  await page.evaluate(y => window.scrollTo(0, y), at.strip! + 100);
  const topBox = (await header.boundingBox())!;
  expect(await hitIn(topBox.x + topBox.width / 2, topBox.y + topBox.height / 2, 'header[data-surface="chrome"]')).toBe(true);

  await page.evaluate(y => window.scrollTo(0, y), at.bar! + 160 - 844 + 60);
  const navBox = (await nav.boundingBox())!;
  expect(await hitIn(navBox.x + navBox.width / 2, navBox.y + navBox.height / 2, "nav")).toBe(true);

  const skip = page.getByRole("link", { name: "skip", exact: true });
  await skip.focus();
  const skipBox = (await skip.boundingBox())!;
  expect(skipBox.y).toBeLessThan(topBox.height);
  expect(await hitIn(skipBox.x + skipBox.width / 2, skipBox.y + skipBox.height / 2, "a.skip")).toBe(true);
});
