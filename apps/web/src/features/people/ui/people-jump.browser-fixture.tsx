// SPDX-License-Identifier: LicenseRef-Proprietary
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { i18n, loadCatalog, t } from "@console/i18n";
import { PeopleJump } from "./people-jump";
import "../../../app.css";

i18n.set("en");
await loadCatalog("en");
// A paragraph, not a heading, marks the page as drawn: a page heading belongs to a real page.
const root = createRootRoute({ component: () => <main><p>{t("people.title")}</p><PeopleJump /></main> });
const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ["/"] }) });
createRoot(document.getElementById("root")!).render(<QueryClientProvider client={new QueryClient()}><RouterProvider router={router} /></QueryClientProvider>);
