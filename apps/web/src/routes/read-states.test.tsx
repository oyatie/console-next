// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { beforeAll, expect, test, vi } from "vitest";
import { ApiError } from "../reference/authz/api";
import { loadCatalog, t } from "@console/i18n";
import { EntityList } from "../features/entity/ui/entity-list";
import { JobTitlesPage } from "../features/people/ui/job-titles-page";
import { TenantsPage } from "../features/platform/ui/tenants-page";
import { Accounts } from "../features/people/ui/accounts-list";
import { entitiesRef } from "../reference/entity/api";
import { jobTitlesQuery } from "../features/people/api";
import { tenantsQuery } from "../features/platform/api";
import { get } from "../lib/query";
import { DayTab } from "../features/attendance/ui/day-tab";
import { MonthTab } from "../features/attendance/ui/month-tab";
import { dayBoardQuery, monthGridPages } from "../features/attendance/api";
import { todayKst } from "../lib/pure/today";
import { StatutoryPage } from "../features/statutory/ui/statutory-page";
import { workplacesQuery } from "../reference/statutory/api";
import { addDays } from "../ui/date/days";

let search: Record<string, string> = {};

vi.mock("@tanstack/react-router", async original => ({
  ...await original<typeof import("@tanstack/react-router")>(),
  useSearch: () => ({}), useNavigate: () => () => {},
  getRouteApi: () => ({ useSearch: () => search, useNavigate: () => () => {} }),
}));
beforeAll(() => loadCatalog("ko"));

const screens = [
  { name: "statutory", component: StatutoryPage, query: workplacesQuery(todayKst()), control: "statutory.workplace" },
  { name: "entities", component: EntityList, query: entitiesRef, control: "entityQuick.title" },
  { name: "job titles", component: JobTitlesPage, query: jobTitlesQuery, control: "titles.add.commit" },
  { name: "platform", component: TenantsPage, query: tenantsQuery, control: "tenants.create" },
  { name: "accounts", component: () => <Accounts q="" />, query: get("/api/v1/directory/people", { params: { query: { limit: 100, include_inactive: false } } }), control: "accounts.includeInactive" },
  { name: "day attendance", component: DayTab, query: dayBoardQuery(addDays(todayKst(), -1)), control: "attendanceRecords.toolbar.prevDay" },
  { name: "month attendance", component: MonthTab, query: monthGridPages(todayKst().slice(0, 7)), control: "attendanceRecords.toolbar.prevMonth" },
] as const;

for (const screen of screens) test.each([403, 503])(`${screen.name}: %i owns the region and never looks empty`, async status => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } });
  if (status === 403 && ["entities", "accounts", "platform"].includes(screen.name)) {
    const data = screen.name === "platform" ? [{ id: "private", slug: "private", name: "private", status: "ACTIVE" }]
      : screen.name === "accounts" ? { pages: [{ items: [], total: 0 }], pageParams: [0] } : { items: [] };
    await client.fetchQuery<unknown>({ ...screen.query, initialPageParam: undefined, queryFn: async () => data });
  }
  const error = new ApiError(status, status === 403 ? "access_denied" : "upstream_failure", "untranslated upstream text", [], "route-reference");
  await client.fetchQuery<never>({ ...screen.query, initialPageParam: undefined, queryFn: async () => { throw error; } }).catch(() => undefined);
  const root = createRootRoute({ component: screen.component });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ["/"] }) });
  await router.load();
  const html = renderToStaticMarkup(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>);
  expect(html).toContain(t(status === 403 ? "common.denied.title.plain" : "common.loadFailed.title"));
  expect(html).toContain("route-reference");
  if (["accounts", "day attendance", "month attendance", "statutory"].includes(screen.name) && status === 503) expect(html).toContain(t(screen.control));
  else expect(html).not.toContain(t(screen.control));
  if (status === 403) expect(html).not.toMatch(/<form|role="tablist"|role="toolbar"/);
  if (status === 403 && screen.name === "accounts") expect(html).not.toContain('aria-labelledby="accounts-title"');
  if (status === 403 && screen.name === "platform") expect(html).not.toContain(t("tenants.search"));
  if (status === 403 && screen.name === "entities") expect(html).not.toContain(t("asof.label"));
  expect(html).not.toContain(t("accounts.noMatch.title"));
  expect(html).not.toContain("untranslated upstream text");
  if (status === 403) expect(html.split(`aria-label="${t("common.denied.title.plain")}"`)).toHaveLength(2);
  else expect(html).toContain(t("common.retry"));
});

for (const tab of ["day", "month"]) test.each([403, 404])(`${tab}: a %s workplace refusal keeps only the recovery picker`, async status => {
  search = { wp: "unavailable" };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } });
  const query = tab === "day" ? dayBoardQuery(addDays(todayKst(), -1), search.wp) : monthGridPages(todayKst().slice(0, 7), search.wp);
  await client.fetchQuery<never>({ ...query, initialPageParam: undefined, queryFn: async () => { throw new ApiError(status, "out_of_scope", ""); } }).catch(() => undefined);
  const router = createRouter({ routeTree: createRootRoute({ component: tab === "day" ? DayTab : MonthTab }), history: createMemoryHistory() });
  await router.load();
  const html = renderToStaticMarkup(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>);
  expect(html).toContain(t("attendanceRecords.scope.label"));
  expect(html.match(/<select\b/g)).toHaveLength(1);
  expect(html).toContain('value="unavailable" disabled="" selected=""');
  expect(html).not.toContain('role="toolbar"');
  expect(html).toContain(t(status === 403 ? "common.denied.title.plain" : "common.read.notFound.title"));
  client.clear();
  search = {};
});
