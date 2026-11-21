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
        resolveId: id => (id === "/approval-viewer-d6-test.js" ? "\0approval-viewer-d6-test" : undefined),
        load: id =>
          id === "\0approval-viewer-d6-test"
            ? `
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
        `
            : undefined,
        configureServer: vite => {
          vite.middlewares.use((req, res, next) => {
            if (req.url?.split("?")[0] !== "/approval-viewer-d6-test") return next();
            res.setHeader("Content-Type", "text/html; charset=utf-8");
            res.end(
              '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>D6</title></head><body><main><div id="root"></div></main><script type="module" src="/approval-viewer-d6-test.js"></script></body></html>',
            );
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
