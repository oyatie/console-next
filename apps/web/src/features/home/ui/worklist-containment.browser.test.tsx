// SPDX-License-Identifier: LicenseRef-Proprietary
import { afterAll, beforeAll, expect, test } from "vitest";
import { i18n, loadCatalog, t } from "@console/i18n";
import { mountBrowserModule, type MountedGallery } from "../../../lib/gallery-browser-test";

let mounted: MountedGallery;
let baseUrl: string;

beforeAll(async () => {
  await loadCatalog("en");
  mounted = await mountBrowserModule({
    slug: "worklist-containment-browser-test",
    viewport: { width: 900, height: 900 },
    readySelector: "main",
    moduleCode: `
      import React, { useState } from 'react';
      import { createRoot } from 'react-dom/client';
      import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
      import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router';
      import { i18n, loadCatalog, t } from '@console/i18n';
      import { Button } from '/apps/web/src/ui/button/button.tsx';
      import { PaneGrid } from '/apps/web/src/ui/pane-grid/pane-grid.tsx';
      import { ALL_OPTIONAL_WORKLIST_COLUMNS } from '/apps/web/src/features/home/domain/inline-decide.ts';
      import { WorklistLower } from '/apps/web/src/features/home/ui/worklist-lower.tsx';
      import { ConsoleWorklistTable } from '/apps/web/src/features/home/ui/worklist-table.tsx';
      import { UnlockReview } from '/apps/web/src/features/periods/ui/unlock-review.tsx';
      import '/apps/web/src/app.css';

      const mode = location.hash.slice(1) || 'en-worklist';
      const locale = mode.endsWith('-ko') ? 'ko' : 'en';
      await loadCatalog(locale);
      i18n.set(locale);
      document.documentElement.lang = locale;
      document.documentElement.dataset.experience = 'console';

      const enItems = [
        {
          id: 'OC-2026-0418', kind: 'org_change_approve', lane: 'turn', title: 'Approval · Org change',
          subject: 'Merge Production Team 3 into Production Team 2 · Effective 11-17',
          site: 'Production Site · Production Team 2', ref: 'OC-2026-0418', urg: 'over',
          due: '2026-11-08T09:00:00+09:00', dueTone: 'danger', done: false, days_remaining: -2, can_decide: true,
          links: [{ kind: 'org_change', id: 'oc-2026-0418' }],
          context: { command: 'approve', drafter: 'Kim Doyeon', reason: 'Line consolidation restructuring' },
        },
        {
          id: 'leave-app-1', kind: 'approval', lane: 'turn', title: 'Approval · Parental leave',
          subject: 'Lee Seoyeon · Sales Operations Team', site: 'HQ · Sales Operations Team', ref: 'AP-2026-0192',
          urg: 'over', due: '2026-11-05T09:00:00+09:00', dueTone: 'danger', done: false, days_remaining: -5,
          can_decide: true, links: [{ kind: 'approval_run', id: 'ap-1' }],
          context: { reason: 'Parental leave eligibility confirmed' },
        },
        {
          id: 'ins-acq-1', kind: 'statutory_deadline', lane: 'turn', title: '4-insurance acquisition',
          subject: 'Park Minjun · 2026-11-09', site: 'HQ · Platform Team', ref: 'INS-2026-011',
          urg: 'now', due: '2026-11-23T09:00:00+09:00', dueTone: 'warn', done: false, days_remaining: 3,
          links: [{ kind: 'statutory', id: 'ins-1' }],
          context: { insurance: { insurer: 'NPS', kind: 'ACQUISITION', effective_date: '2026-11-09' }, reason: '14-day statutory filing window' },
        },
      ];

      const opsItems = [
        {
          id: 'period_unlock:exc-1', kind: 'period_unlock', lane: 'turn', title: 'Kim Doyeon', site: 'HQ · Payroll',
          urg: 'now', due: '2026-11-08T09:00:00+09:00', dueTone: 'danger', done: false, days_remaining: -2,
          links: [{ kind: 'period_lock', id: 'pl-1' }],
          context: { unlock: { domain: 'payroll', periodStart: '2026-10-01', periodEnd: '2026-10-31', requester: 'Kim Doyeon', reason_code: 'RETRO_CORRECTION', exceptionId: 'exc-1' } },
        },
        {
          id: 'att-close-1', kind: 'period_unlock', lane: 'turn', title: 'Attendance close', site: 'Production Site',
          urg: 'over', due: '2026-11-08T09:00:00+09:00', dueTone: 'danger', done: false, days_remaining: -2,
          links: [{ kind: 'period_lock', id: 'pl-2' }],
        },
        {
          id: 'payroll-run-1', kind: 'payroll', lane: 'turn', title: 'November payroll', site: 'All sites',
          urg: 'today', due: '2026-11-25T09:00:00+09:00', dueTone: 'warn', done: false, days_remaining: 15,
          links: [{ kind: 'pay_run', id: 'pr-1' }],
        },
      ];

      function OpsHarness() {
        return React.createElement(
          'main', { id: 'main', className: 'main' },
          React.createElement(WorklistLower, {
            items: opsItems, asOf: '2026-11-10T09:00:00+09:00', canOrgStructure: false,
            action: row => row.context?.unlock?.exceptionId ? React.createElement(UnlockReview, { lockId: 'pl-1', exceptionId: 'exc-1' }) : null,
          }),
        );
      }

      function EnWorklistHarness() {
        const [selected, setSelected] = useState(mode === 'en-worklist-open' ? 'OC-2026-0418' : '');
        return React.createElement(
          'main', { id: 'main', className: 'main' },
          React.createElement(PaneGrid, {
            main: React.createElement(ConsoleWorklistTable, {
              items: enItems, selected: selected || undefined, onSelect: setSelected,
              checkedIds: new Set(), onToggleCheck: () => {}, onToggleAll: () => {},
              shownCols: new Set(ALL_OPTIONAL_WORKLIST_COLUMNS),
              inlineRowAction: item => item.can_decide
                ? React.createElement(React.Fragment, null, React.createElement(Button, { size: 'sm' }, t('uiWorklist.reject')), React.createElement(Button, { size: 'sm', variant: 'primary' }, t('uiWorklist.approve')))
                : null,
            }),
            onSelect: setSelected,
            record: selected ? { id: selected, label: 'Record', title: selected, onClose: () => setSelected(''), children: React.createElement('div', null, selected) } : null,
          }),
        );
      }

      const component = mode.startsWith('ops-') ? OpsHarness : EnWorklistHarness;
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const root = createRootRoute();
      const router = createRouter({
        routeTree: root.addChildren([
          createRoute({ getParentRoute: () => root, path: '/', component }),
          createRoute({ getParentRoute: () => root, path: '/org/changes/$id', component: () => null }),
          createRoute({ getParentRoute: () => root, path: '/people/$id', component: () => null }),
          createRoute({ getParentRoute: () => root, path: '/people/period-locks', component: () => null }),
          createRoute({ getParentRoute: () => root, path: '/payroll/runs/$id', component: () => null }),
        ]),
        history: createMemoryHistory({ initialEntries: ['/'] }),
      });
      createRoot(document.getElementById('root')).render(
        React.createElement(QueryClientProvider, { client }, React.createElement(RouterProvider, { router })),
      );
    `,
  });
  baseUrl = mounted.page.url().split("#")[0]!;
}, 60_000);

afterAll(async () => {
  await mounted?.close();
});

test("WorklistLower Monthly operations keeps UnlockReview, Open links, and 403 CommandError inside td[2] at 390px and 320px in Vite dev (en & ko)", async () => {
  const { page } = mounted;
  try {
    await page.route("**/api/v1/access/me", route =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ is_ops: false, entries: [], decisions: {} }) }),
    );
    await page.route("**/api/v1/period-locks/**", route =>
      route.fulfill({
        status: 403,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "forbidden", message: "Permission_denied_unbroken_reference_token_for_wrapping_check", operation_id: "00000000-0000-4000-8000-000000000099" } }),
      }),
    );

    for (const locale of ["en", "ko"] as const) {
      await loadCatalog(locale);
      i18n.set(locale);
      for (const width of [390, 320] as const) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto("about:blank");
        await page.goto(`${baseUrl}#ops-${locale}`);
        const opsTable = page.getByRole("table", { name: t("home.worklist.opsTitle"), exact: true });
        await opsTable.waitFor();
        await opsTable.getByRole("button", { name: t("periodLocks.review.acknowledge"), exact: true }).waitFor();

        const metrics = await opsTable.evaluate((table, { vw, openLabel }) => {
          const scroller = table.parentElement!;
          const wrap = scroller.parentElement!;
          const cues = wrap.querySelectorAll("[data-scroll-cue]").length;
          const controlChecks = [...table.querySelectorAll<HTMLElement>("tbody a[href], tbody button")].map(ctrl => {
            const td = ctrl.closest("td")!;
            const rect = ctrl.getBoundingClientRect();
            const tdRect = td.getBoundingClientRect();
            const tdPadRight = Number.parseFloat(getComputedStyle(td).paddingRight) || 0;
            const isOpen = ctrl.textContent?.trim() === openLabel;
            let singleLine = true;
            if (isOpen) {
              const range = document.createRange();
              range.selectNodeContents(ctrl);
              singleLine = range.getClientRects().length <= 1;
            }
            return {
              insideLeft: rect.left >= tdRect.left - 1,
              insideRight: rect.right <= tdRect.right + 1,
              insideViewport: rect.right <= vw + 1,
              flushRight: !isOpen || Math.abs(rect.right - (tdRect.right - tdPadRight)) <= 2,
              singleLine,
            };
          });
          return {
            minWidth: getComputedStyle(table).minWidth,
            opsSW: Math.round(table.scrollWidth),
            scrollerCW: Math.round(scroller.clientWidth),
            cues,
            controlChecks,
          };
        }, { vw: width, openLabel: t("home.inbox.open") });

        expect(metrics.minWidth).toBe("0px");
        expect(metrics.opsSW).toBeLessThanOrEqual(metrics.scrollerCW + 1);
        expect(metrics.cues).toBe(0);
        expect(metrics.controlChecks.length).toBeGreaterThanOrEqual(3);
        for (const check of metrics.controlChecks) {
          expect(check).toEqual({ insideLeft: true, insideRight: true, insideViewport: true, flushRight: true, singleLine: true });
        }

        await opsTable.getByRole("button", { name: t("periodLocks.review.acknowledge"), exact: true }).click();
        const alert = opsTable.locator('[role="alert"], [role="status"]').first();
        await alert.waitFor();
        const alertCheck = await alert.evaluate(el => {
          const td = el.closest("td")!;
          const rect = el.getBoundingClientRect();
          const tdRect = td.getBoundingClientRect();
          return { insideLeft: rect.left >= tdRect.left - 1, insideRight: rect.right <= tdRect.right + 1, fits: el.scrollWidth <= el.clientWidth + 1 };
        });
        expect(alertCheck).toEqual({ insideLeft: true, insideRight: true, fits: true });
      }
    }
  } finally {
    await page.unroute("**/api/v1/access/me");
    await page.unroute("**/api/v1/period-locks/**");
  }
}, 45_000);

test("ConsoleWorklistTable + PaneGrid contains horizontal overflow in en at 900px / and 1024/1120/1440px split-pane", async () => {
  const { page } = mounted;
  await loadCatalog("en");
  i18n.set("en");

  await page.setViewportSize({ width: 900, height: 900 });
  await page.goto("about:blank");
  await page.goto(`${baseUrl}#en-worklist`);
  const queue900 = page.getByRole("grid", { name: t("home.inbox.title"), exact: true });
  await queue900.waitFor();
  const res900 = await queue900.evaluate(table => {
    const main = document.getElementById("main")!;
    const scroller = table.parentElement!;
    return { mainFits: main.scrollWidth <= main.clientWidth, scrollerCW: Math.round(scroller.clientWidth), tableSW: Math.round(table.scrollWidth) };
  });
  expect(res900.mainFits).toBe(true);
  expect(res900.scrollerCW).toBeLessThanOrEqual(900);
  expect(res900.tableSW).toBeLessThanOrEqual(res900.scrollerCW + 1);

  for (const width of [1024, 1120, 1440] as const) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("about:blank");
    await page.goto(`${baseUrl}#en-worklist-open`);
    const queue = page.getByRole("grid", { name: t("home.inbox.title"), exact: true });
    await queue.waitFor();
    const record = page.locator('aside[data-pane="record"]');
    await record.waitFor();
    const res = await queue.evaluate(table => {
      const main = document.getElementById("main")!;
      const scroller = table.parentElement!;
      const aside = document.querySelector('aside[data-pane="record"]')!;
      return {
        mainFits: main.scrollWidth <= main.clientWidth,
        scrollerBeforeAside: scroller.getBoundingClientRect().right <= aside.getBoundingClientRect().left + 1,
        tableFits: table.scrollWidth <= scroller.clientWidth + 1,
        overflowX: getComputedStyle(scroller).overflowX,
      };
    });
    expect(res.mainFits).toBe(true);
    expect(res.scrollerBeforeAside).toBe(true);
    expect(res.tableFits || res.overflowX === "auto").toBe(true);
    const approveBtn = queue.locator('tbody tr[data-id="OC-2026-0418"]').getByRole("button", { name: t("uiWorklist.approve"), exact: true });
    if (!res.tableFits) {
      await queue.locator("xpath=..").evaluate(el => { el.scrollLeft = el.scrollWidth; });
    }
    const btnFits = await approveBtn.evaluate(btn => {
      const aside = document.querySelector('aside[data-pane="record"]')!;
      return btn.getBoundingClientRect().right <= aside.getBoundingClientRect().left + 1;
    });
    expect(btnFits).toBe(true);
  }
}, 45_000);
