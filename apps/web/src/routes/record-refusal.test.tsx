// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { beforeAll, expect, test, vi } from "vitest";
import { ApiError } from "../reference/authz/api";
import { loadCatalog, t } from "@console/i18n";
import { EntityRecord } from "../features/entity/ui/entity-record";
import { entityQuery } from "../features/entity/api";
import { IdentifiersPage } from "../features/identifiers/ui/identifiers-page";
import { employeeRef } from "../features/identifiers/api";
import { ExitCasePage } from "../features/people/ui/exit-page";
import { caseQuery } from "../features/people/api";

vi.mock("@tanstack/react-router", async original => ({
  ...await original<typeof import("@tanstack/react-router")>(),
  getRouteApi: () => ({ useParams: () => ({ id: "record" }), useSearch: () => ({}), useNavigate: () => () => {} }),
}));
beforeAll(() => loadCatalog("ko"));

const privateName = "접근을 잃은 기록";
const screens = [
  { name: "exit", component: ExitCasePage, query: caseQuery("record"), action: "exit.group.cancel",
    data: { id: "record", employee_id: "person", employee_name: privateName, employee_number: "PRIVATE", status: "HR_CONFIRMED", exit_reason_code: "GROUP_TRANSFER", exit_event_state: "SCHEDULED" } },
  { name: "identifiers", component: IdentifiersPage, query: employeeRef("record"), action: "identifiers.title",
    data: { employee: { id: "record", name: privateName } } },
  { name: "entity", component: () => <EntityRecord id="record" />, query: entityQuery("record"), action: "entityRecord.action.chart",
    data: { id: "record", biz_kind: "CORPORATION", can_manage: true, current: { name: privateName, representatives: [], directors: [] }, registrations: [], workplaces: [], scheduled: [], identity_problems: [], name_reviews: [] } },
] as const;

for (const screen of screens) test.each([403, 404])(`${screen.name}: a %s refetch removes the cached record head and actions`, async status => {
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false, retryOnMount: false } } });
  await client.fetchQuery<unknown>({ ...screen.query, queryFn: async () => screen.data });
  await client.fetchQuery<never>({ ...screen.query, queryFn: async () => { throw new ApiError(status, status === 403 ? "forbidden" : "not_found", "lost"); } }).catch(() => undefined);
  expect(client.getQueryCache().find(screen.query)?.state.data).toEqual(screen.data);
  const router = createRouter({ routeTree: createRootRoute({ component: screen.component }), history: createMemoryHistory() });
  await router.load();
  const html = renderToStaticMarkup(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>);
  expect(html).toContain(t(status === 403 ? "common.denied.title.plain" : "common.read.notFound.title"));
  expect(html).not.toContain(privateName);
  expect(html).not.toContain(t(screen.action, { name: privateName }));
  expect(html.match(/<h1\b/g)).toHaveLength(1);
  expect(html).not.toContain(t("asof.label"));
  client.clear();
});
