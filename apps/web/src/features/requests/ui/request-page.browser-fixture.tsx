// SPDX-License-Identifier: LicenseRef-Proprietary
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { i18n, loadCatalog } from "@console/i18n";
import { RequestPage } from "./request-page";
import "../../../app.css";

i18n.set("en");
await loadCatalog("en");
const params = new URLSearchParams(location.search);
// The style is read from the page root, where the app's boot script puts the stored one.
if (params.get("look") === "console") document.documentElement.dataset.experience = "console";
// The page reads its route by id, so the tree has the app's shape: a pathless parent, then the request.
const root = createRootRoute();
const app = createRoute({ getParentRoute: () => root, id: "app" });
const request = createRoute({ getParentRoute: () => app, path: "/requests/$id", component: RequestPage });
const lookup = createRoute({ getParentRoute: () => app, path: "/requests" });
const router = createRouter({
  routeTree: root.addChildren([app.addChildren([request, lookup])]),
  history: createMemoryHistory({ initialEntries: [`/requests/${params.get("id")}`] }),
});
createRoot(document.getElementById("root")!).render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><RouterProvider router={router} /></QueryClientProvider>);
