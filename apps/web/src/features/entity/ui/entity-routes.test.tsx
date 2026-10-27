// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import { ApiError, entityQuery } from "../api";
import { NewWorkplaceScreen } from "./entity-routes";

const navigate = vi.hoisted(() => vi.fn(() => null));
vi.mock("@tanstack/react-router", async original => ({
  ...await original<typeof import("@tanstack/react-router")>(),
  getRouteApi: () => ({ useParams: () => ({ id: "entity" }) }),
  Navigate: navigate,
}));
beforeAll(() => loadCatalog("ko"));
beforeEach(() => navigate.mockClear());

async function render(client: QueryClient) {
  const router = createRouter({ routeTree: createRootRoute({ component: NewWorkplaceScreen }), history: createMemoryHistory() });
  await router.load();
  return renderToStaticMarkup(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>);
}

const clientForRead = () => new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false, retryOnMount: false } } });

test.each([403, 404])("the old workplace address keeps a %s answer on the shared read state", async status => {
  const client = clientForRead();
  await client.fetchQuery({ ...entityQuery("entity"), queryFn: async () => { throw new ApiError(status, status === 403 ? "forbidden" : "not_found", "refused"); } }).catch(() => undefined);
  const html = await render(client);
  expect(html).toContain(t(status === 403 ? "common.denied.title.plain" : "common.read.notFound.title"));
  expect(navigate).not.toHaveBeenCalled();
  client.clear();
});

test("the old workplace address waits for the entity read before navigating", async () => {
  const client = clientForRead();
  const html = await render(client);
  expect(html).toContain(t("common.loading"));
  expect(navigate).not.toHaveBeenCalled();
  client.clear();
});

test("an existing entity still opens its workplace create sheet with replace navigation", async () => {
  const client = clientForRead();
  await client.fetchQuery({ ...entityQuery("entity"), queryFn: async () => ({ id: "entity" }) });
  await render(client);
  expect(navigate).toHaveBeenCalledWith(expect.objectContaining({ to: "/org", search: { sel: "entity", act: "wp-create" }, replace: true }), undefined);
  client.clear();
});
