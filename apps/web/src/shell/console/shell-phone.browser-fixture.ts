// SPDX-License-Identifier: LicenseRef-Proprietary
import { AxeBuilder } from "@axe-core/playwright";
import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createServer } from "vite";
import { loadCatalog, t } from "@console/i18n";
import { browserEngine, browserTestOptimizeDeps, openBrowserTestPage, type Page } from "../../lib/browser-test";

/** The signed-in session: set by the page at once, or returned by the refresh a cold open restores through. */
const TOKEN = {
  access_token: `h.${Buffer.from(JSON.stringify({ sub: "hero", org: "tenant", name: "Hajun" })).toString("base64url")}.s`,
  token_type: "Bearer", refresh_expires_at: "2099-01-01T00:00:00Z", requires_passkey_setup: false,
};
/** A platform operator's session: the frame sends no tenant reader's read for it. */
const OPERATOR = { ...TOKEN, access_token: `h.${Buffer.from(JSON.stringify({ sub: "operator", org: "platform", platform: true })).toString("base64url")}.s` };

export type Held = { asked: () => void; done: Promise<void> };
type PhoneShellOptions = { restore?: Held; held?: Held & { path: string }; refused?: string; width?: number; operator?: boolean; inbox?: { total: number; exact: boolean } };

/** Serves the Console shell over a stub screen and opens it in one browser page, which every test of a file shares. */
export async function phoneShellFixture() {
  await loadCatalog("ko");
  const server = await createServer({
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
        import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
        import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider, useLocation, useNavigate, useParams, useRouter } from '@tanstack/react-router';
        import { configure, session } from '@console/api';
        import { webPlatform } from '@console/api/web';
        import { useSidePanel } from '/apps/web/src/lib/side-panel/use-side-panel.ts';
        import { loadCatalog } from '@console/i18n';
        import { ConsoleShell } from '/apps/web/src/shell/console/shell.tsx';
        import { employeeQuery } from '/apps/web/src/features/people/api/employee-read.ts';
        import '/apps/web/src/app.css';
        await loadCatalog('ko');
        // ?cold opens with no session, as a reload does, so the shell restores it through the refresh the test answers.
        // ?operator opens as a platform operator.
        if (location.search.includes('cold')) configure(webPlatform); else session.set(location.search.includes('operator') ? ${JSON.stringify(OPERATOR)} : ${JSON.stringify(TOKEN)});
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
            h('button', { type: 'button', onClick: () => void navigate({ href: '/people/p1' }) }, 'go-person'),
          );
        }
        // A record screen: its tab shows a stand-in title until the record's own read names it.
        function Person() {
          const { id } = useParams({ strict: false });
          return h('h1', null, useQuery(employeeQuery(id)).data?.employee?.name ?? 'person');
        }
        // The frame's skip link comes before the shell, as ShellFrame draws it.
        const root = createRootRoute({ component: () => h(React.Fragment, null, h('a', { className: 'skip', href: '#main' }, 'skip'), h(ConsoleShell)) });
        const mk = (path, title) => createRoute({ getParentRoute: () => root, path, staticData: { access: 'signed-in' }, component: () => h(Screen, { title }) });
        const router = createRouter({
          routeTree: root.addChildren([mk('/', 'Home'), mk('/account', 'Account'), mk('/leave', 'Leave'), mk('/payslips', 'Payslips'),
            createRoute({ getParentRoute: () => root, path: '/people/$id', staticData: { access: 'signed-in' }, component: Person })]),
          history: createMemoryHistory({ initialEntries: ['/account'] }),
        });
        createRoot(document.getElementById('root')).render(h(QueryClientProvider, { client: qc }, h(RouterProvider, { router })));
      ` : undefined,
    }],
  });
  await server.listen();
  const browser = await browserEngine().launch();
  const page = await (await browser.newContext()).newPage();

  /**
   * `restore` opens cold: the page starts with no session, and the refresh that restores it waits for `restore.done`.
   * `held` holds the read at `held.path` until `held.done`; `refused` refuses the read at that path, once its hold ends.
   */
  async function open(link: "LINKED" | "UNLINKED" = "LINKED", { restore, held, refused, width = 390, operator = false, inbox }: PhoneShellOptions = {}) {
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
      "/api/v1/me/action-inbox": { items: [], next_cursor: null, counts: { turn: { total: inbox?.total ?? 0, total_is_exact: inbox?.exact ?? true } }, attention_filters: [] },
      "/api/v1/auth/passkeys": [],
      "/api/v1/employees/p1": { employee: { name: "Minji Kim" } },
      // The reader's own choice keeps the page in Console once the shell syncs the style.
      "/api/v1/me/workspace": { layout: { experience: "console" } },
    };
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.route(url => url.pathname.endsWith("/console-phone-nav-test"), route => route.fulfill({
      contentType: "text/html",
      body: '<html lang="ko" data-experience="console"><title>Console Phone</title><div id="root"></div><script type="module" src="/console-phone-nav-test.js"></script></html>',
    }));
    await page.route("**/api/v1/**", async route => {
      const path = new URL(route.request().url()).pathname;
      if (restore && path === "/api/v1/auth/token/refresh") { restore.asked(); await restore.done; return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(TOKEN) }); }
      if (held && path === held.path) { held.asked(); await held.done; }
      if (path === refused) return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ code: "service_unavailable", message: "unavailable" }) });
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(apiMocks[path] ?? { items: [] }) });
    });

    await openBrowserTestPage(page, `${server.resolvedUrls!.local[0]}console-phone-nav-test${restore ? "?cold" : operator ? "?operator" : ""}`, page.locator('[data-phone-screen="Account"]'));
    return page.getByRole("navigation", { name: t("shell.nav"), exact: true });
  }

  return { page, open, close: async () => { await page.close(); await browser.close(); await server.close(); } };
}

/** Two frames: whatever a change asked to draw has drawn. */
export const frames = (page: Page) => page.evaluate(() => new Promise<void>(ok => requestAnimationFrame(() => requestAnimationFrame(() => ok()))));

/** Where the page starts below the top, and how much room is left after it, in page coordinates. */
export const pageFrame = (page: Page) => page.evaluate(() => {
  const main = document.getElementById("main")!.getBoundingClientRect();
  return { above: main.top + window.scrollY, below: document.scrollingElement!.scrollHeight - (main.bottom + window.scrollY) };
});

/** Links whose name leaves out the words they show, so a spoken label would not reach them. */
export const nameMismatches = async (page: Page) => (await new AxeBuilder({ page }).withRules(["label-content-name-mismatch"]).analyze())
  .violations.flatMap(violation => violation.nodes.map(node => node.html));
