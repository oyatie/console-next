// SPDX-License-Identifier: LicenseRef-Proprietary
import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { expect, type Browser, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, test } from "vitest";
import { browserEngine, browserTestOptimizeDeps } from "../../../lib/browser-test";

const ENGINES = [browserEngine()];
let server: ViteDevServer;
const sessions: { browser: Browser; page: Page }[] = [];

beforeAll(async () => {
  server = await createServer({
    configFile: false,
    cacheDir: ".cache/approval-viewer-d6-test",
    logLevel: "error",
    optimizeDeps: browserTestOptimizeDeps,
    server: {
      host: "127.0.0.1",
      port: 0,
      watch: null,
      hmr: false,
      fs: { allow: [resolve("."), dirname(realpathSync("node_modules/pretendard"))] },
    },
    plugins: [
      {
        name: "approval-viewer-d6-test",
        resolveId: id =>
          id === "/approval-viewer-d6-test.js"
            ? "\0approval-viewer-d6-test"
            : id === "/queue-stepper-test.js"
              ? "\0queue-stepper-test"
              : undefined,
        load: id => {
          if (id === "\0approval-viewer-d6-test") {
            return `
          import React, { useState } from 'react';
          import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
          import { createRoot } from 'react-dom/client';
          import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router';
          import { i18n, loadCatalog, t } from '@console/i18n';
          import { approvalDocumentQuery } from '/apps/web/src/features/approvals/api.ts';
          import { ApprovalDecisionPanel } from '/apps/web/src/features/approvals/ui/approval-viewer.tsx';
          import '/apps/web/src/app.css';

          await loadCatalog('en');
          i18n.set('en');

          function Demo() {
            const q = useQuery(approvalDocumentQuery('doc-d6'));
            const [receipt, setReceipt] = useState();
            if (!q.data) return null;
            return React.createElement(ApprovalDecisionPanel, {
              document: q.data,
              receipt,
              onReceipt: setReceipt,
              showNext: true,
            });
          }

          const root = createRootRoute({ component: Outlet });
          const index = createRoute({ getParentRoute: () => root, path: '/', component: Demo });
          const approvals = createRoute({ getParentRoute: () => root, path: '/approvals', component: () => null });
          const router = createRouter({
            routeTree: root.addChildren([index, approvals]),
            history: createMemoryHistory({ initialEntries: ['/'] }),
          });
          await router.load();
          createRoot(document.getElementById('root')).render(
            React.createElement(QueryClientProvider, { client: new QueryClient() }, React.createElement(RouterProvider, { router }))
          );
        `;
          }
          if (id === "\0queue-stepper-test") {
            return `
          import React from 'react';
          import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
          import { createRoot } from 'react-dom/client';
          import { createMemoryHistory, createRootRoute, createRoute, createRouter, Link, Outlet, RouterProvider, useParams } from '@tanstack/react-router';
          import { i18n, loadCatalog, t } from '@console/i18n';
          import { approvalPages } from '/apps/web/src/features/approvals/api.ts';
          import { approvalQueueContextFromPages } from '/apps/web/src/features/approvals/present.ts';
          import { readIdentity } from '/apps/web/src/lib/query.ts';
          import { markActiveCachedQuery, useCachedInfinitePages } from '/apps/web/src/lib/react/cached-pages.ts';
          import { Button } from '/apps/web/src/ui/button/button.tsx';
          import { DocQueueStepper } from '/apps/web/src/ui/patterns/document-decision-parts.tsx';
          import '/apps/web/src/app.css';

          await loadCatalog('en');
          i18n.set('en');

          const params = new URLSearchParams(location.search);
          const scenario = params.get('scenario') ?? 'reset';
          const initialDoc = scenario === 'search' ? 'AP-2026-0419' : 'OC-2026-0418';
          const qc = new QueryClient({ defaultOptions: { queries: { staleTime: 30000, gcTime: 300000 } } });
          const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

          const unfilteredDesc = approvalPages({ box: 'pending' });
          const q0418Desc = approvalPages({ box: 'pending', q: '0418' });
          const q0419Desc = approvalPages({ box: 'pending', q: '0419' });

          if (scenario === 'reset') {
            await qc.fetchInfiniteQuery(q0418Desc);
            await sleep(20);
            await qc.fetchInfiniteQuery(unfilteredDesc);
          } else if (scenario === 'search') {
            await qc.fetchInfiniteQuery(unfilteredDesc);
            await sleep(20);
            await qc.fetchInfiniteQuery(q0419Desc);
          } else if (scenario === 'staleReset') {
            await qc.fetchInfiniteQuery(unfilteredDesc);
            await sleep(20);
            await qc.fetchInfiniteQuery(q0418Desc);
            await sleep(20);
            markActiveCachedQuery(qc, readIdentity(unfilteredDesc));
          }

          function StepperHarness() {
            const { approvalId } = useParams({ strict: false });
            const pages = useCachedInfinitePages(
              '/api/v1/approvals',
              candidate => candidate.some(page => page.items.some(item => item.id === approvalId)),
            );
            const queueCtx = approvalQueueContextFromPages(pages, approvalId);
            if (!queueCtx) return React.createElement('div', { id: 'missing' }, 'missing');
            return React.createElement(DocQueueStepper, {
              prev: queueCtx.prevId
                ? React.createElement(Link, { to: '/approvals/$approvalId', params: { approvalId: queueCtx.prevId }, 'aria-label': t('approvals.console.prevDoc') }, 'Prev')
                : React.createElement(Button, { disabled: true, 'aria-label': t('approvals.console.prevDoc') }, 'Prev'),
              label: t('approvals.console.queuePos', { n: queueCtx.index, total: queueCtx.total }),
              next: queueCtx.nextId
                ? React.createElement(Link, { to: '/approvals/$approvalId', params: { approvalId: queueCtx.nextId }, 'aria-label': t('approvals.console.nextDoc') }, 'Next')
                : React.createElement(Button, { disabled: true, 'aria-label': t('approvals.console.nextDoc') }, 'Next'),
            });
          }

          const root = createRootRoute({ component: Outlet });
          const viewer = createRoute({ getParentRoute: () => root, path: '/approvals/$approvalId', component: StepperHarness });
          const router = createRouter({
            routeTree: root.addChildren([viewer]),
            history: createMemoryHistory({ initialEntries: ['/approvals/' + initialDoc] }),
          });
          await router.load();
          createRoot(document.getElementById('root')).render(
            React.createElement(QueryClientProvider, { client: qc }, React.createElement(RouterProvider, { router }))
          );
        `;
          }
          return undefined;
        },
        configureServer: vite => {
          vite.middlewares.use((req, res, next) => {
            const pathname = req.url?.split("?")[0];
            if (pathname === "/approval-viewer-d6-test") {
              res.setHeader("Content-Type", "text/html; charset=utf-8");
              res.end(
                '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>D6</title></head><body><main><div id="root"></div></main><script type="module" src="/approval-viewer-d6-test.js"></script></body></html>',
              );
              return;
            }
            if (pathname === "/queue-stepper-test") {
              res.setHeader("Content-Type", "text/html; charset=utf-8");
              res.end(
                '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Queue</title></head><body><main><div id="root"></div></main><script type="module" src="/queue-stepper-test.js"></script></body></html>',
              );
              return;
            }
            next();
          });
        },
      },
    ],
  });
  await server.listen();
  for (const engine of ENGINES) {
    const browser = await engine.launch();
    const page = await browser.newPage();
    sessions.push({ browser, page });
  }
}, 60_000);

afterAll(async () => {
  await Promise.all(sessions.map(({ browser }) => browser.close()));
  await server?.close();
});

test.each(ENGINES.map((_, engine) => ({ engine })))(
  "ApprovalDecisionPanel keeps ApprovalCard mounted and focuses recorded h2 when refetch flips my_actions to none in engine $engine",
  async ({ engine }) => {
    const { page } = sessions[engine]!;
    let decided = false;
    await page.route("**/api/v1/approvals/doc-d6", route =>
      route.fulfill({
        status: 200,
        json: {
          id: "doc-d6",
          box: "pending",
          title: "Merge teams",
          summary: "Combine teams",
          document_no: "OC-2026-0418",
          source: { key: "org_change", label: "Organization change" },
          status: { key: decided ? "APPROVED" : "IN_APPROVAL" },
          requester: { id: "u1", name: "Kim" },
          requested_at: "2026-11-06T09:00:00Z",
          facts: [],
          route: [
            {
              id: "s1",
              role_key: "hr",
              assignee: "Moon",
              state: decided ? "done" : "current",
            },
          ],
          viewer: { kind: "org_change", id: "c1" },
          body: [],
          revision: 1,
          fingerprint: "fp-1",
          consequence: "final",
          opinion_max: 500,
          my_actions: decided
            ? { kind: "none" }
            : { kind: "approve", reject: { consequence: "request_ends", reason_domain: "org_change_reject" } },
        },
      }),
    );
    await page.route("**/api/v1/reason-codes**", route =>
      route.fulfill({ status: 200, json: { items: [] } }),
    );
    await page.route("**/api/v1/approvals/doc-d6/decision", route => {
      decided = true;
      return route.fulfill({ status: 200, json: { decision: "APPROVED", status: "APPROVED" } });
    });

    await page.goto(`${server.resolvedUrls!.local[0]}approval-viewer-d6-test`);
    const approveBtn = page.getByRole("button", { name: "Approve", exact: true });
    await expect(approveBtn).toBeVisible();
    await approveBtn.click();

    const article = page.getByRole("article", { name: "Approval decision", exact: true });
    await expect(article).toBeVisible();
    const heading = article.getByRole("heading", { level: 2, name: "Approval decision", exact: true });
    await expect(heading).toHaveAttribute("tabindex", "-1");
    await expect(heading).toBeFocused();
    await expect(article.getByRole("status")).toHaveText("Approved. The approval is complete.");
    await expect(article.getByRole("link", { name: "Approval inbox", exact: true })).toHaveAttribute("href", "/approvals");
  },
);

test.each(ENGINES.map((_, engine) => ({ engine })))(
  "useCachedInfinitePages selects single coherent query across filtered/unfiltered cache entries in engine $engine",
  async ({ engine }) => {
    const { page } = sessions[engine]!;
    const makeSummary = (id: string) => ({
      id,
      box: "pending",
      title: id,
      summary: id,
      source: { key: "org_change", label: "Organization change" },
      status: { key: "IN_APPROVAL" },
      requested_at: "2026-11-06T09:00:00Z",
      facts: [],
      route: [],
    });
    const allIds = ["OC-2026-0418", "AP-2026-0419", "AP-2026-0420", "AP-2026-0421", "AP-2026-0422", "AP-2026-0423"];
    await page.route("**/api/v1/approvals**", route => {
      const q = new URL(route.request().url()).searchParams.get("q");
      const items = q
        ? allIds.filter(id => id.includes(q)).map(makeSummary)
        : allIds.map(makeSummary);
      return route.fulfill({
        status: 200,
        json: {
          items,
          focused: null,
          counts: { pending: 6, upcoming: 2, requested: 3, reference: 2, completed: 8 },
          sources: [],
          next_cursor: null,
        },
      });
    });

    // 1. Filtered -> unfiltered reset selects 6-item list without self-loop.
    await page.goto(`${server.resolvedUrls!.local[0]}queue-stepper-test?scenario=reset`);
    await expect(page.getByText("1 of 6", { exact: true })).toBeVisible();
    let listRequestsAfterMount = 0;
    const countListRequest = (req: { url: () => string }) => {
      if (new URL(req.url()).pathname === "/api/v1/approvals") listRequestsAfterMount++;
    };
    page.on("request", countListRequest);
    const nextLink = page.getByRole("link", { name: "Next approval", exact: true });
    await expect(nextLink).toHaveAttribute("href", "/approvals/AP-2026-0419");
    await nextLink.click();
    await expect(page.getByText("2 of 6", { exact: true })).toBeVisible();
    page.off("request", countListRequest);
    expect(listRequestsAfterMount).toBe(0);

    // 2. Unfiltered -> search 0419 selects 1-item filtered list with disabled Next button.
    await page.goto(`${server.resolvedUrls!.local[0]}queue-stepper-test?scenario=search`);
    await expect(page.getByText("1 of 1", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Next approval", exact: true })).toBeDisabled();

    // 3. Stale-cache filter reset (unfiltered cached before search, re-activated without refetch) selects 6-item list.
    await page.goto(`${server.resolvedUrls!.local[0]}queue-stepper-test?scenario=staleReset`);
    await expect(page.getByText("1 of 6", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Next approval", exact: true })).toHaveAttribute("href", "/approvals/AP-2026-0419");
  },
);
