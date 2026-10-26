// SPDX-License-Identifier: LicenseRef-Proprietary
import { lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { configure } from "@console/api";
import { loadCatalog, t } from "@console/i18n";
import { RouteGuard } from "../../reference/authz/ui/access-gate";
import { TextInput } from "../../ui/field/field";
import "../../app.css";

await loadCatalog("ko");
configure({ baseUrl: location.origin, refresh: { kind: "cookie" }, passkeys: { get: async () => null, create: async () => null } });
export default function Editor() { return <TextInput aria-label={t("orgChange.reason")} />; }
const Page = lazy(async () => {
  await fetch("/guard-page");
  return { default: Editor };
});
const root = createRootRoute({ component: () => <Suspense fallback={<p>{t("common.loading")}</p>}><Outlet /></Suspense> });
const app = createRoute({ getParentRoute: () => root, id: "app", staticData: { access: "signed-in" }, component: () => <>
  <nav aria-label={t("shell.main")}>{t("shell.main")}</nav>
  <main><RouteGuard><Outlet /></RouteGuard></main>
</> });
const guarded = createRoute({ getParentRoute: () => app, path: "/guarded", staticData: { access: { domain: "org", level: "view" } }, component: Page });
const tenant = createRoute({ getParentRoute: () => app, path: "/tenant", staticData: { access: { domain: "org", level: "view", tenant: true } }, component: Page });
const signedIn = createRoute({ getParentRoute: () => app, path: "/signed-in", staticData: { access: "signed-in" }, component: Page });
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const router = createRouter({ routeTree: root.addChildren([app.addChildren([guarded, tenant, signedIn])]), history: createMemoryHistory({ initialEntries: [new URL(location.href).searchParams.get("route") ?? "/guarded"] }) });
createRoot(document.getElementById("root")!).render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>);
