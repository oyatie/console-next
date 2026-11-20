// SPDX-License-Identifier: LicenseRef-Proprietary
import { t } from "@console/i18n";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { mountBrowserModule, type MountedGallery } from "../../lib/gallery-browser-test";
import { expectPatternMatrixClean, openPatternFixture, setConsoleViewport } from "./pattern-browser-helpers";

let mounted: MountedGallery;

beforeAll(async () => {
  mounted = await openPatternFixture("document-decision");
}, 60_000);

afterAll(async () => {
  await mounted?.close();
});

test("DocumentDecision passes WCAG 2.2 AA matrix and enforces multiline opinion on reject/return", async () => {
  const { page } = mounted;
  await expectPatternMatrixClean(page);
  await setConsoleViewport(page, 1440, 900);

  const area = page.locator("[data-decision-pane] textarea");
  await area.waitFor();
  await page.getByRole("button", { name: t("uiWorklist.reject"), exact: true }).click();
  expect(await page.locator('[data-decision-pane] [role="alert"]').textContent()).toContain(
    t("uiWorklist.opinionRequired"),
  );
  expect(await area.evaluate(el => document.activeElement === el)).toBe(true);

  await area.fill("Consolidated staffing plan verified.");
  await page.getByRole("button", { name: t("uiWorklist.return"), exact: true }).click();
  expect(await page.locator("[data-outcome]").getAttribute("data-outcome")).toBe("returned");

  await page.getByRole("button", { name: t("uiWorklist.approve"), exact: true }).click();
  expect(await page.locator("[data-outcome]").getAttribute("data-outcome")).toBe("approved");
}, 45_000);

describe("DocumentDecision phone heading under keepPreviousData 403 refusal", () => {
  let phoneApp: MountedGallery;

  beforeAll(async () => {
    phoneApp = await mountBrowserModule({
      slug: "doc-decision-keepprev-403",
      lang: "en",
      readySelector: '[data-pattern="document-decision"] [data-pane="record"]',
      viewport: { width: 390, height: 844 },
      moduleCode: `
        import React, { useState } from 'react';
        import { createRoot } from 'react-dom/client';
        import { QueryClient, QueryClientProvider, keepPreviousData, useQuery } from '@tanstack/react-query';
        import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
        import { ApiError } from '@console/api';
        import { loadCatalog } from '@console/i18n';
        import { DocumentDecision } from '/apps/web/src/ui/patterns/document-decision.tsx';
        import { read } from '/apps/web/src/lib/query.ts';
        import '/apps/web/src/app.css';

        await loadCatalog('en');
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

        function Harness() {
          const [mode, setMode] = useState('ok');
          const q = useQuery({
            ...read('/api/v1/doc-keepprev', () => {
              if (mode === '403') return Promise.reject(new ApiError(403, 'access_denied', '', [], 'op-doc-403'));
              return Promise.resolve({ id: 'OC-1' });
            }, mode),
            placeholderData: keepPreviousData,
          });
          return React.createElement(React.Fragment, null,
            React.createElement('button', { type: 'button', 'data-refuse': '', onClick: () => setMode('403') }, 'Refuse'),
            React.createElement(DocumentDecision, {
              q,
              head: { title: 'Approvals', titleId: 'doc-h1' },
              document: React.createElement('div', null, 'Document'),
              decision: { id: 'OC-1', label: 'Decision', onClose: () => undefined, children: React.createElement('p', null, 'Body') },
            }),
          );
        }
        const router = createRouter({ routeTree: createRootRoute({ component: Harness }), history: createMemoryHistory({ initialEntries: ['/'] }) });
        await router.load();
        createRoot(document.getElementById('root')).render(React.createElement(QueryClientProvider, { client }, React.createElement(RouterProvider, { router })));
      `,
    });
  }, 60_000);

  afterAll(async () => {
    await phoneApp?.close();
  });

  test("restores visible h1 on phone when SidePaneSpec read turns 403", async () => {
    const { page } = phoneApp;
    await page.setViewportSize({ width: 390, height: 844 });
    const h1 = page.locator("#doc-h1");
    expect((await h1.boundingBox())?.height ?? 0).toBe(0);
    await page.locator("[data-refuse]").click();
    await page.getByText("op-doc-403").waitFor();
    expect((await h1.boundingBox())?.height ?? 0).toBeGreaterThan(0);
  });
});
