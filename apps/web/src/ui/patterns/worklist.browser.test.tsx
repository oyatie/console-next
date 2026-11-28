// SPDX-License-Identifier: LicenseRef-Proprietary
import { loadCatalog, t } from "@console/i18n";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { mountBrowserModule, mountGalleryEntry, scanWcag22Matrix, type MountedGallery } from "../../lib/gallery-browser-test";

let mounted: MountedGallery;

beforeAll(async () => {
  await loadCatalog("ko");
  mounted = await mountGalleryEntry({
    name: "worklist-pattern",
    entryPath: "/apps/web/src/ui/patterns/worklist.fixture.tsx",
    readySelector: '[data-pattern="worklist"]',
  });
}, 60_000);

afterAll(async () => {
  await mounted?.close();
});

test("WorklistExample clears typed opinion when switching records", async () => {
  const { page } = mounted;
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: new RegExp(t("home.attention.all")) }).click();
  await page.locator('tbody tr[data-id="W-3"]').click();
  const input = page.locator("[data-decision-pane] input");
  await input.fill("Opinion for W-3");
  expect(await input.inputValue()).toBe("Opinion for W-3");

  await page.locator('tbody tr[data-id="W-1"]').click();
  expect(await page.locator('[data-pane="record"]').textContent()).toContain("W-1");
  expect(await input.inputValue()).toBe("");
});

test("Worklist pattern passes WCAG 2.2 AA axe checks at 1440 and 390 and filters and dismisses the record pane", async () => {
  const { page } = mounted;
  expect(await scanWcag22Matrix(page)).toEqual([]);

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => {
    document.documentElement.dataset.experience = "console";
    document.documentElement.dataset.theme = "light";
  });

  await page.getByRole("button", { name: new RegExp(t("home.attention.overdue")) }).click();
  expect(await page.locator("tbody tr[data-id]").count()).toBe(1);

  await page.getByRole("complementary", { name: t("home.inbox.record.title") }).getByRole("button").first().focus();
  await page.keyboard.press("Escape");
  expect(await page.locator('[data-pane="record"]').count()).toBe(0);
}, 30_000);

describe("Worklist phone heading under latched keepPreviousData refusal", () => {
  let phoneApp: MountedGallery;

  beforeAll(async () => {
    phoneApp = await mountBrowserModule({
      slug: "worklist-keepprev-403-test",
      lang: "en",
      readySelector: '[data-pattern="worklist"] [data-pane="record"]',
      viewport: { width: 390, height: 844 },
      moduleCode: `
        import React, { useState } from 'react';
        import { createRoot } from 'react-dom/client';
        import { QueryClient, QueryClientProvider, keepPreviousData, useQuery } from '@tanstack/react-query';
        import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
        import { ApiError } from '@console/api';
        import { loadCatalog } from '@console/i18n';
        import { Worklist } from '/apps/web/src/ui/patterns/worklist.tsx';
        import { read } from '/apps/web/src/lib/query.ts';
        import '/apps/web/src/app.css';

        await loadCatalog('en');
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

        function Harness() {
          const [mode, setMode] = useState('ok');
          const q = useQuery({
            ...read('/api/v1/worklist-keepprev', () => {
              if (mode === '403') {
                document.documentElement.dataset.pendingMode = '403';
                return Promise.reject(new ApiError(403, 'access_denied', '', [], 'op-keepprev-403'));
              }
              if (mode === 'slow-ok') {
                return new Promise(resolve => {
                  window.resolveSlowOkWorklist = () => resolve([{ id: 'W-1b', name: 'Row 1b' }]);
                  document.documentElement.dataset.pendingMode = 'slow-ok';
                });
              }
              if (mode === 'slow') {
                return new Promise(resolve => {
                  window.resolveSlowWorklist = () => resolve([{ id: 'W-2', name: 'Row 2' }]);
                  document.documentElement.dataset.pendingMode = 'slow';
                });
              }
              document.documentElement.dataset.pendingMode = 'ok';
              return Promise.resolve([{ id: 'W-1', name: 'Row 1' }]);
            }, mode),
            placeholderData: keepPreviousData,
          });

          return React.createElement(React.Fragment, null,
            React.createElement('div', { 'data-controls': '', 'data-mode-state': mode + ':' + (q.isFetching ? 'fetching' : q.status) },
              React.createElement('button', { type: 'button', 'data-mode': 'ok', onClick: () => setMode('ok') }, 'OK'),
              React.createElement('button', { type: 'button', 'data-mode': 'slow-ok', onClick: () => setMode('slow-ok') }, 'SlowOK'),
              React.createElement('button', { type: 'button', 'data-mode': '403', onClick: () => setMode('403') }, '403'),
              React.createElement('button', { type: 'button', 'data-mode': 'slow', onClick: () => setMode('slow') }, 'Slow'),
            ),
            React.createElement(Worklist, {
              q,
              head: { title: 'Inbox Worklist', titleId: 'keepprev-worklist-title' },
              list: React.createElement('div', null, 'List body'),
              record: {
                id: 'W-1',
                label: 'Selected record',
                title: 'Row 1',
                onClose: () => undefined,
                children: React.createElement('p', null, 'Record detail'),
              },
            }),
          );
        }

        const route = createRootRoute({ component: Harness });
        const router = createRouter({ routeTree: route, history: createMemoryHistory({ initialEntries: ['/'] }) });
        await router.load();
        createRoot(document.getElementById('root')).render(
          React.createElement(QueryClientProvider, { client },
            React.createElement(RouterProvider, { router }),
          ),
        );
      `,
    });
  }, 60_000);

  afterAll(async () => {
    await phoneApp?.close();
  });

  test("keeps h1 visible at 390px during latched 403 refusal under keepPreviousData and hides it again when record returns", async () => {
    const { page } = phoneApp;
    await page.setViewportSize({ width: 390, height: 844 });
    const measure = () => page.evaluate(() => {
      const h1 = document.getElementById("keepprev-worklist-title");
      const head = document.querySelector('[data-pattern="worklist"] > :has(h1)');
      return {
        recordCount: document.querySelectorAll('[data-pane="record"]').length,
        headHeight: head ? head.getBoundingClientRect().height : 0,
        h1Height: h1 ? h1.getBoundingClientRect().height : 0,
        h1Display: h1 ? getComputedStyle(h1).display : null,
        hasSupportRef: document.body.textContent?.includes("op-keepprev-403") ?? false,
      };
    });

    // Initial ok state: record pane is mounted and phone collapses .head while keeping h1 accessible
    const initial = await measure();
    expect(initial.recordCount).toBe(1);
    expect(initial.headHeight).toBe(0);

    // Non-refused keepPreviousData refetch: record remains mounted and .head stays collapsed
    await page.locator('[data-mode="slow-ok"]').click();
    await page.locator('[data-controls][data-mode-state="slow-ok:fetching"]').waitFor();
    await page.waitForFunction(() => document.documentElement.dataset.pendingMode === "slow-ok");
    const nonRefusedPending = await measure();
    expect(nonRefusedPending.recordCount).toBe(1);
    expect(nonRefusedPending.headHeight).toBe(0);
    await page.evaluate(() => (window as unknown as { resolveSlowOkWorklist?: () => void }).resolveSlowOkWorklist?.());

    // 403 refusal: PageReadGate renders <Denied> and h1 is visible
    await page.locator('[data-mode="403"]').click();
    await page.getByText("op-keepprev-403").waitFor();
    const refused = await measure();
    expect(refused.recordCount).toBe(0);
    expect(refused.hasSupportRef).toBe(true);
    expect(refused.headHeight).toBeGreaterThan(0);
    expect(refused.h1Height).toBeGreaterThan(0);
    expect(refused.h1Display).not.toBe("none");

    // Pending keepPreviousData refetch after 403: PageReadGate latches refusal, h1 stays visible
    await page.locator('[data-mode="slow"]').click();
    await page.locator('[data-controls][data-mode-state="slow:fetching"]').waitFor();
    await page.waitForFunction(() => document.documentElement.dataset.pendingMode === "slow");
    const latched = await measure();
    expect(latched.recordCount).toBe(0);
    expect(latched.hasSupportRef).toBe(true);
    expect(latched.headHeight).toBeGreaterThan(0);
    expect(latched.h1Height).toBeGreaterThan(0);
    expect(latched.h1Display).not.toBe("none");

    // Resolving slow query clears latched refusal and restores phone detail view
    await page.evaluate(() => (window as unknown as { resolveSlowWorklist?: () => void }).resolveSlowWorklist?.());
    await page.locator('[data-pane="record"]').waitFor();
    const recovered = await measure();
    expect(recovered.recordCount).toBe(1);
    expect(recovered.headHeight).toBe(0);
  });
});
