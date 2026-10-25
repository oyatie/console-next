// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { beforeAll, expect, test } from "vitest";
import type { components } from "@console/api/schema";
import { loadCatalog, t } from "@console/i18n";
import { ApiError } from "../../../reference/authz/api";
import { changeQuery } from "../api";
import { OrgChange } from "./org-change-record";

beforeAll(() => loadCatalog("ko"));
const record: components["schemas"]["OrgChangeDetail"] = {
  id: "opened-change", code: "OC-2026-0012", kind: "NEW", status: "APPLIED",
  target: { kind: "ORG_UNIT", ref: "unit", label: "인재개발팀" },
  effectiveDate: "2026-10-16", reason: "보존할 변경 사유", headcount: 0, siteCount: 0, teamCount: 1,
  draftedBy: "drafter", draftedByName: "김인사", createdAt: "2026-10-09T05:06:00Z", updatedAt: "2026-10-09T05:06:00Z",
  proposal: [], approvalSteps: [], settlementItems: [], events: [],
};

test.each([403, 404])("the org-change route preserves its loaded record after a %s refetch", async status => {
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false, retryOnMount: false } } });
  const query = changeQuery(record.id);
  await client.fetchQuery({ ...query, queryFn: async () => record });
  const root = createRootRoute();
  const app = createRoute({ getParentRoute: () => root, id: "app" });
  const detail = createRoute({ getParentRoute: () => app, path: "/org/changes/$id", component: OrgChange });
  const router = createRouter({ routeTree: root.addChildren([app.addChildren([detail])]), history: createMemoryHistory({ initialEntries: [`/org/changes/${record.id}`] }) });
  await router.load();
  const markup = () => renderToStaticMarkup(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>);
  expect(markup()).toContain(record.reason);
  await expect(client.fetchQuery({ ...query, queryFn: async () => { throw new ApiError(status, status === 404 ? "not_found" : "forbidden", "lost"); } })).rejects.toBeInstanceOf(ApiError);
  const html = markup();
  expect(html).toContain(record.reason);
  expect(html).toContain(record.code);
  expect(html).toContain(t(status === 404 ? "live.notice.gone" : "live.notice.no_access"));
  expect(html).toContain('inert=""');
  expect(html).not.toContain(t("common.read.notFound.title"));
  expect(html).not.toContain(t("common.denied.title.plain"));
  client.clear();
});
