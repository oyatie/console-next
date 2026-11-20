// SPDX-License-Identifier: LicenseRef-Proprietary
import { afterAll, beforeAll, expect, test } from "vitest";
import { loadCatalog } from "@console/i18n";
import { mountBrowserModule, type MountedGallery } from "../../../lib/gallery-browser-test";

let mounted: MountedGallery;

beforeAll(async () => {
  await loadCatalog("ko");
  mounted = await mountBrowserModule({
    slug: "worklist-console-browser-test",
    viewport: { width: 900, height: 844 },
    readySelector: '[data-id="fold:fold-a"]',
    moduleCode: `
      import React, { useState } from 'react';
      import { createRoot } from 'react-dom/client';
      import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
      import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router';
      import { loadCatalog } from '@console/i18n';
      import { PaneGrid } from '/apps/web/src/ui/pane-grid/pane-grid.tsx';
      import { ALL_OPTIONAL_WORKLIST_COLUMNS } from '/apps/web/src/features/home/domain/inline-decide.ts';
      import { ConsoleWorklistTable } from '/apps/web/src/features/home/ui/worklist-table.tsx';
      import '/apps/web/src/app.css';

      await loadCatalog('ko');
      document.documentElement.dataset.experience = 'console';

      const items = [
        {
          id: 'fold-a',
          kind: 'register_review',
          lane: 'turn',
          title: 'Address missing A',
          ref: 'REG-1',
          fold_key: 'fold-reg',
          urg: 'today',
          due: '2026-11-12T00:00:00+09:00',
          dueTone: 'warn',
          done: false,
          days_remaining: 2,
          links: [{ kind: 'employee', id: 'e1' }],
        },
        {
          id: 'fold-b',
          kind: 'register_review',
          lane: 'turn',
          title: 'Address missing B',
          ref: 'REG-2',
          fold_key: 'fold-reg',
          urg: 'today',
          due: '2026-11-12T00:00:00+09:00',
          dueTone: 'warn',
          done: false,
          days_remaining: 2,
          links: [{ kind: 'employee', id: 'e2' }],
        },
        {
          id: 'single-1',
          kind: 'org_change_approve',
          lane: 'turn',
          title: 'Org merge',
          ref: 'OC-1',
          urg: 'over',
          due: '2026-11-08T00:00:00+09:00',
          dueTone: 'danger',
          done: false,
          days_remaining: -2,
          links: [{ kind: 'org_change', id: 'oc-1' }],
        },
      ];

      function Harness() {
        const [selected, setSelected] = useState('single-1');
        return React.createElement(PaneGrid, {
          main: React.createElement(ConsoleWorklistTable, {
            items,
            selected,
            onSelect: setSelected,
            checkedIds: new Set(),
            onToggleCheck: () => {},
            onToggleAll: () => {},
            shownCols: new Set(ALL_OPTIONAL_WORKLIST_COLUMNS),
          }),
          onSelect: id => { if (!id.startsWith('fold:')) setSelected(id); },
          record: {
            id: selected,
            label: 'Record',
            title: 'Selected',
            onClose: () => setSelected(''),
            children: React.createElement('div', null, selected),
          },
        });
      }

      const client = new QueryClient();
      const root = createRootRoute();
      const indexRoute = createRoute({ getParentRoute: () => root, path: '/', component: Harness });
      const changeRoute = createRoute({ getParentRoute: () => root, path: '/org/changes/$id', component: () => null });
      const employeeRoute = createRoute({ getParentRoute: () => root, path: '/people/$id', component: () => null });
      const router = createRouter({
        routeTree: root.addChildren([indexRoute, changeRoute, employeeRoute]),
        history: createMemoryHistory({ initialEntries: ['/'] }),
      });
      createRoot(document.getElementById('root')).render(
        React.createElement(QueryClientProvider, { client }, React.createElement(RouterProvider, { router })),
      );
    `,
  });
}, 60_000);

afterAll(async () => {
  await mounted?.close();
});

test("narrow 900px split-pane keeps .phoneDue visible and DueCell in compact pill mode, and Enter on collapsed fold preserves row focus", async () => {
  const { page } = mounted;
  const splitMetrics = await page.evaluate(() => {
    const row = document.querySelector<HTMLElement>('[data-id="single-1"]')!;
    const dueCell = row.querySelector<HTMLElement>('[data-tone]')!;
    const phoneDue = row.querySelector<HTMLElement>('[class*="phoneDue"]')!;
    const container = row.closest<HTMLElement>('[class*="container"]')!;
    return {
      containerWidth: Math.round(container.getBoundingClientRect().width),
      rowDisplay: getComputedStyle(row).display,
      phoneDueDisplay: getComputedStyle(phoneDue).display,
      phoneDueWidth: Math.round(phoneDue.getBoundingClientRect().width),
      dueCellDisplay: getComputedStyle(dueCell).display,
      dueCellRadius: getComputedStyle(dueCell).borderRadius,
    };
  });

  expect(splitMetrics.containerWidth).toBeLessThanOrEqual(480);
  expect(splitMetrics.rowDisplay).toBe("grid");
  expect(splitMetrics.phoneDueDisplay).not.toBe("none");
  expect(splitMetrics.phoneDueWidth).toBeGreaterThan(0);
  expect(splitMetrics.dueCellDisplay).toBe("inline-flex");
  expect(splitMetrics.dueCellRadius).not.toBe("0px");

  const collapsedFold = page.locator('[data-id="fold:fold-a"]');
  await collapsedFold.focus();
  await page.keyboard.press("Enter");

  const expandedFold = page.locator('[data-id="fold-a"]');
  await expandedFold.waitFor();
  await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute("data-id"))).toBe("fold-a");
});
