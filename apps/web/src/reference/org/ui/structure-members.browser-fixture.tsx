// SPDX-License-Identifier: LicenseRef-Proprietary
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { loadCatalog, t } from "@console/i18n";
import { authzQuery } from "../../authz/api";
import { invalidatePaths } from "../../../lib/query";
import { Button } from "../../../ui/button/button";
import { Members } from "./structure-members";
import { Sec } from "./panel-shell";
import "../../../app.css";

await loadCatalog("ko");
const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
// Keep the capability projection granted while the directory itself refuses a refresh.
await client.fetchQuery({
  ...authzQuery,
  queryFn: async () => ({ capabilities: [{ feature: "employee_directory_read", permission: "allow", org_wide: true }] }),
});
const root = createRootRoute({
  component: () => <>
    <Sec id="wp-people" title={t("orgStructure.wp.people", { count: 0 })}>
      <Members unitId="00000000-0000-0000-0000-000000000001" total={0} expected={0} />
    </Sec>
    <Button aria-label="Refresh directory" onClick={() => void invalidatePaths(client, ["/api/v1/employees"])}>{t("common.retry")}</Button>
  </>,
});
const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ["/"] }) });
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>,
);
