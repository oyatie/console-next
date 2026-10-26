// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { loadCatalog, t } from "@console/i18n";
import { tg } from "@console/i18n/gallery";
import { DeptDetails } from "./dept-details";
import "../../../app.css";

await loadCatalog("ko");
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const name = tg("sample.dept");
const appoint = new URLSearchParams(location.search).get("mode") !== "details";
export function Fixture() {
  const [done, setDone] = useState(false);
  return done ? <p role="status">{t("orgUnit.details.done", { name })}</p> : <DeptDetails appoint={appoint} onDone={() => setDone(true)} node={{ id: "00000000-0000-4000-8000-000000000100", kind: "DEPARTMENT", name, code: "QA-1", version: 7, headcount: 1, direct_headcount: 1, dispatched_headcount: 0, chips: [], children: [] }} />;
}
const router = createRouter({ routeTree: createRootRoute({ component: Fixture }), history: createMemoryHistory({ initialEntries: ["/"] }) });
createRoot(document.getElementById("root")!).render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>);
