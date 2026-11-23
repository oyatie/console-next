// SPDX-License-Identifier: LicenseRef-Proprietary
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { i18n, loadCatalog } from "@console/i18n";
import { EmployeeCard } from "./card-page";
import "../../../app.css";

i18n.set("en");
await loadCatalog("en");
// The card reads its route by id, so the tree has the app's shape: a pathless parent, then the person. The page is the
// real one: its section links, its sections and the digit keys it binds.
const TABS = ["events", "docs", "ledger", "access"] as const;
const text = (x: unknown) => (typeof x === "string" ? x : undefined);
const root = createRootRoute();
const app = createRoute({ getParentRoute: () => root, id: "app" });
const card = createRoute({
  getParentRoute: () => app,
  path: "/people/$id",
  validateSearch: (s: Record<string, unknown>) => ({ act: text(s.act), back: text(s.back), tab: TABS.find((x) => x === s.tab) }),
  component: EmployeeCard,
});
// The head looks the pay page's route up by its path to read its access rule; here it has none, so no pay link shows.
const pay = createRoute({ getParentRoute: () => app, path: "/payroll/employees/$employeeId" });
const router = createRouter({
  routeTree: root.addChildren([app.addChildren([card, pay])]),
  history: createMemoryHistory({ initialEntries: [`/people/${new URLSearchParams(location.search).get("person")}`] }),
});
createRoot(document.getElementById("root")!).render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><RouterProvider router={router} /></QueryClientProvider>);
