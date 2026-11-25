// SPDX-License-Identifier: LicenseRef-Proprietary
import { afterAll, beforeAll, expect, test } from "vitest";
import { mountBrowserModule, type MountedGallery } from "../../../lib/gallery-browser-test";

let mounted: MountedGallery;

// The Console position catalog for someone who keeps it, with one title at the longest length the API takes and no
// break in it (as keep-all Korean has none).
beforeAll(async () => {
  mounted = await mountBrowserModule({
    slug: "job-titles-page-test",
    readySelector: "table",
    viewport: { width: 1440, height: 900 },
    moduleCode: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
      import { createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router';
      import { loadCatalog } from '@console/i18n';
      import { jobTitleSchemas, jobTitlesQuery } from '/apps/web/src/features/people/api.ts';
      import { JobTitlesPage } from '/apps/web/src/features/people/ui/job-titles-page.tsx';
      import '/apps/web/src/app.css';
      await loadCatalog('ko');
      document.documentElement.dataset.experience = 'console';
      const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
      const label = 'W'.repeat(jobTitleSchemas.update.properties.label.maxLength);
      client.setQueryData(jobTitlesQuery.queryKey, { can_manage: true, items: [{ id: 'jt-1', kind: 'TITLE', label, grade_rank: 10, active: true }] });
      const root = createRootRoute({ component: JobTitlesPage });
      const router = createRouter({ routeTree: root.addChildren([createRoute({ getParentRoute: () => root, path: '/people' })]) });
      await router.load();
      createRoot(document.getElementById('root')).render(
        React.createElement(QueryClientProvider, { client }, React.createElement(RouterProvider, { router })));
    `,
  });
}, 60_000);

afterAll(async () => {
  await mounted?.close();
});

// Console fits the other columns to their content, so the title's own cell is the one that gives way: the title wraps
// there, and the row's actions stay inside the window instead of being pushed past its edge.
test.each([1440, 1280])("a full-length title wraps and keeps its row's actions in view at %spx", async width => {
  const { page } = mounted;
  await page.setViewportSize({ width, height: 900 });
  const row = page.getByRole("row").filter({ hasText: "WWWW" });
  const actions = await row.locator("td").last().evaluate(el => el.getBoundingClientRect().right);
  expect(actions).toBeLessThanOrEqual(width);
  expect(await page.evaluate(() => document.scrollingElement!.scrollWidth - innerWidth)).toBe(0);
});
