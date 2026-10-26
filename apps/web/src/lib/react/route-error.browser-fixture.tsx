// SPDX-License-Identifier: LicenseRef-Proprietary
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { api, configure, unwrap } from "@console/api";
import { webPlatform } from "@console/api/web";
import { loadCatalog } from "@console/i18n";
import { RouteError } from "./route-error";

await loadCatalog("ko");
configure(webPlatform);
const root = createRootRoute({ component: () => <main data-shell><Outlet /></main> });
const page = createRoute({ getParentRoute: () => root, path: "/route-error-test", loader: async () => {
  if (location.hash === "#bug") throw new TypeError("Cannot read properties of undefined");
  await unwrap(api.GET("/api/v1/legal-entities"));
}, component: () => <p data-loaded /> });
const router = createRouter({ routeTree: root.addChildren([page]), defaultErrorComponent: RouteError });
createRoot(document.getElementById("root")!).render(<QueryClientProvider client={new QueryClient()}><RouterProvider router={router} /></QueryClientProvider>);
