// SPDX-License-Identifier: LicenseRef-Proprietary
import { AxeBuilder } from "@axe-core/playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import { mountBrowserModule, type MountedGallery } from "../../../lib/gallery-browser-test";

let mounted: MountedGallery;

beforeAll(async () => {
  await loadCatalog("ko");
  mounted = await mountBrowserModule({
    slug: "worklist-console-more-browser-test",
    viewport: { width: 1440, height: 900 },
    readySelector: '[data-id="row-0"]',
    moduleCode: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { QueryClient, QueryClientProvider, useInfiniteQuery } from '@tanstack/react-query';
      import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router';
      import { loadCatalog } from '@console/i18n';
      import { cursorRead } from '/apps/web/src/lib/query.ts';
      import { InboxReadContext } from '/apps/web/src/features/home/ui/use-inbox-read.ts';
      import { WorklistConsole } from '/apps/web/src/features/home/ui/worklist-console.tsx';
      import '/apps/web/src/app.css';

      await loadCatalog('ko');
      document.documentElement.dataset.experience = 'console';

      const page = (count, all) => ({
        items: Array.from({ length: count }, (_, i) => ({
          id: 'row-' + i, kind: 'insurance_filing', lane: 'turn', title: 'Insurance filing ' + i, ref: 'INS-' + i,
          urg: 'wait', due: '2026-11-17T00:00:00+09:00', due_basis: 'statutory', dueTone: 'neutral', done: false,
          days_remaining: 7, links: [{ kind: 'statutory', id: 'ins-' + i }],
        })),
        total: count, total_is_exact: true, next_cursor: null, unavailable: [], available_filters: ['turn', 'waiting'],
        attention_filters: [{ key: 'all', total: all, total_is_exact: true }],
        counts: { turn: { total: count, total_is_exact: true } }, upcoming: [], has_work: true, quick_starts: [],
        as_of: '2026-11-10T09:00:00+09:00',
      });

      function Home({ count, all }) {
        const inbox = useInfiniteQuery({ ...cursorRead('/inbox-test', { count, all }, async () => page(count, all)), enabled: true });
        return React.createElement(InboxReadContext.Provider, { value: { inbox, attention: 'all', setAttention: () => {} } },
          React.createElement(WorklistConsole, { mode: 'home', title: 'Home', titleId: 'home-title', baseline: () => null }));
      }

      let root;
      window.mountHome = (count, all = count) => {
        root?.unmount();
        const rootRoute = createRootRoute();
        const router = createRouter({
          routeTree: rootRoute.addChildren([
            createRoute({ getParentRoute: () => rootRoute, path: '/', component: () => React.createElement(Home, { count, all }) }),
            createRoute({ getParentRoute: () => rootRoute, path: '/inbox', component: () => null }),
          ]),
          history: createMemoryHistory({ initialEntries: ['/'] }),
        });
        const client = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false } } });
        root = createRoot(document.getElementById('root'));
        root.render(React.createElement(QueryClientProvider, { client }, React.createElement(RouterProvider, { router })));
      };
      window.mountHome(31);
    `,
  });
}, 60_000);

afterAll(async () => {
  await mounted?.close();
});

const inboxLink = () => mounted.page.getByRole("link", { name: t("home.inbox.viewInbox"), exact: true });

async function mountHome(count: number, all = count) {
  await mounted.page.evaluate(([n, a]) => (window as unknown as { mountHome: (count: number, all: number) => void }).mountHome(n, a), [count, all] as const);
  await mounted.page.locator(count ? '[data-pattern="worklist"] tbody tr[data-id]' : '[data-pattern="worklist"] [class*="moreBar"]').first().waitFor();
}

async function expectBarAccessible() {
  for (const theme of ["light", "dark"]) {
    await mounted.page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
    const scan = await new AxeBuilder({ page: mounted.page }).include('[class*="moreBar"]').withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    expect(scan.violations.map(violation => `${theme}: ${violation.id}`)).toEqual([]);
  }
}

async function showMore(remaining: number) {
  await mounted.page.getByRole("button", { name: t("home.worklist.moreCount", { count: remaining }), exact: true }).click();
}

test("the to-do link stays beside the more bar while a long home list unfolds", async () => {
  await mountHome(31);
  await expect.poll(() => inboxLink().count()).toBe(1);
  for (const remaining of [21, 11, 1]) {
    await showMore(remaining);
    await expect.poll(() => inboxLink().count(), { message: `after showing the remaining ${remaining}` }).toBe(1);
  }
  await expect.poll(() => mounted.page.locator('[data-pattern="worklist"] tbody tr[data-id]').count()).toBe(31);
});

test("a short home list unfolds in place with the to-do link beside the more bar throughout", async () => {
  await mountHome(23);
  await expect.poll(() => inboxLink().count()).toBe(1);
  await showMore(13);
  await expect.poll(() => inboxLink().count()).toBe(1);
  await showMore(3);
  await expect.poll(() => inboxLink().count()).toBe(1);
});

test("a short chip of a long home list keeps the to-do link", async () => {
  await mountHome(15, 2000);
  await expect.poll(() => inboxLink().count()).toBe(1);
});

test.each([1440, 390])("the more bar keeps its button and the to-do link apart inside the bar, accessible in both themes, at %ipx", async width => {
  await mounted.page.setViewportSize({ width, height: 900 });
  await mountHome(31);
  const more = mounted.page.getByRole("button", { name: t("home.worklist.moreCount", { count: 21 }), exact: true });
  const metrics = await (await inboxLink().elementHandle())!.evaluate((link, buttonBox) => {
    const barBox = link.parentElement!.getBoundingClientRect();
    const linkBox = link.getBoundingClientRect();
    return {
      gap: linkBox.left - (buttonBox.x + buttonBox.width),
      inside: linkBox.right <= barBox.right + 0.5 && buttonBox.x >= barBox.left - 0.5,
      overflow: link.parentElement!.scrollWidth - link.parentElement!.clientWidth,
    };
  }, (await more.boundingBox())!);
  expect(metrics.gap).toBeGreaterThanOrEqual(8);
  expect(metrics.inside).toBe(true);
  expect(metrics.overflow).toBeLessThanOrEqual(0);
  await expectBarAccessible();
});

test.each([[3, 1440], [3, 390], [0, 1440], [0, 390]])("with %i rows the to-do link stands alone in its bar, accessible in both themes, at %ipx", async (count, width) => {
  await mounted.page.setViewportSize({ width, height: 900 });
  await mountHome(count);
  await expect.poll(() => inboxLink().count()).toBe(1);
  const bar = mounted.page.locator('[class*="moreBar"]');
  await expect.poll(() => bar.locator("button").count()).toBe(0);
  expect(await bar.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
  await expectBarAccessible();
});
