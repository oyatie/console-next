// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { i18n, loadCatalog } from "@console/i18n";
import { placesOf, type Node } from "../../../reference/org/domain/structure";
import { DeptDissolveSheet } from "./dept-dissolve-sheet";
import "../../../app.css";

await loadCatalog("en");
i18n.set("en");
const node = (id: string, kind: Node["kind"], name: string, children: Node[] = []): Node =>
  ({ id, kind, name, children, headcount: 2, direct_headcount: 2, dispatched_headcount: 0, chips: [] });
const places = placesOf({ entities: [node("entity", "LEGAL_ENTITY", "Hanbit Foods", [
  node("seoul", "WORKPLACE", "Seoul office", [node("operations", "DEPARTMENT", "Operations", [node("packing", "DEPARTMENT", "Packing")]), node("support", "DEPARTMENT", "Support")]),
])] } as Parameters<typeof placesOf>[0]);
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

/** The sheet that dissolves Packing, whose two members go to Operations unless someone chooses otherwise. */
export function Fixture() {
  const [open, setOpen] = useState(true);
  return (
    <main>
      {open && <DeptDissolveSheet place={places.get("packing")!} places={places} company="hanbit" onClose={() => setOpen(false)} />}
      <output id="open">{open ? "open" : "closed"}</output>
    </main>
  );
}
const router = createRouter({ routeTree: createRootRoute({ component: Fixture }), history: createMemoryHistory({ initialEntries: ["/"] }) });
createRoot(document.getElementById("root")!).render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>);
