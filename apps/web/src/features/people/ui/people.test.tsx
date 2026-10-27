// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { beforeAll, expect, test, vi } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import { authzQuery } from "../../../reference/authz/api";
import { PeopleDirectory } from "../People";

vi.mock("@tanstack/react-router", async importOriginal => ({
  ...await importOriginal<typeof import("@tanstack/react-router")>(),
  getRouteApi: () => ({ useSearch: () => ({}), useNavigate: () => () => {} }),
}));
beforeAll(() => loadCatalog("ko"));

test("an account with no directory or account-management grant sees one refusal", async () => {
  const client = new QueryClient();
  await client.fetchQuery({ ...authzQuery, queryFn: async () => ({ capabilities: [] }) });
  const root = createRootRoute({ component: PeopleDirectory });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ["/"] }) });
  await router.load();
  const html = renderToStaticMarkup(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>);
  expect(html).toContain(t("common.denied.title.plain"));
  expect(html).not.toContain(t("accounts.noMatch.title"));
  expect(html.split(`aria-label="${t("common.denied.title.plain")}"`)).toHaveLength(2);
});
