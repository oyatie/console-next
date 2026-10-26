// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, expect, test } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { ApiError } from "@console/api";
import { loadCatalog, t } from "@console/i18n";
import { RouteError } from "./route-error";

beforeAll(() => loadCatalog("ko"));
async function failedLoader(error: Error) {
  const root = createRootRoute({ component: () => <main data-shell><Outlet /></main> });
  const page = createRoute({ getParentRoute: () => root, path: "/people/import", loader: () => { throw error; }, component: () => null });
  const router = createRouter({ routeTree: root.addChildren([page]), defaultErrorComponent: RouteError,
    history: createMemoryHistory({ initialEntries: ["/people/import"] }) });
  await router.load();
  return renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}><RouterProvider router={router} /></QueryClientProvider>);
}

test.each([401, 503])("a loader ApiError(%s) keeps the shell and offers read retry", async status => {
  const html = await failedLoader(new ApiError(status, "service_unavailable", "unavailable", [], "loader-reference"));
  expect(html).toContain("data-shell");
  expect(html).toContain(t("common.loadFailed.title"));
  expect(html).toContain(t("common.retry"));
  expect(html).toContain("loader-reference");
  expect(html).not.toContain(t("common.crashed.title"));
});

test.each([new TypeError("Failed to fetch"), new TypeError("Load failed"), new TypeError("NetworkError when attempting to fetch resource."), new DOMException("timed out", "TimeoutError")])("a loader transport failure offers read retry: %s", async error => {
  expect(await failedLoader(error)).toContain(t("common.loadFailed.title"));
});

test.each([new TypeError("Cannot read properties of undefined"), new Error("render failed")])("a programming error keeps the crash screen: %s", async error => {
  const html = await failedLoader(error);
  expect(html).toContain(t("common.crashed.title"));
  expect(html).not.toContain(t("common.loadFailed.title"));
});
