// SPDX-License-Identifier: LicenseRef-Proprietary
import { createRoot } from "react-dom/client";
import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { i18n, loadCatalog } from "@console/i18n";
import type { KindRule } from "../domain/scope";
import { ScopeSheet } from "./scope-picker";
import "../../../app.css";

await loadCatalog("en");
i18n.set("en");
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const RULES: KindRule[] = (["TENANT", "LEGAL_ENTITY", "WORKPLACE"] as const).map((kind) => ({ kind, enforceable: true, descendants_only: true }));

/** The scope sheet as the grant sheet hands over to it, for a line with no scope yet; the test serves the structure. */
export function Fixture() {
  const [open, setOpen] = useState(true);
  return (
    <main>
      {open && <ScopeSheet rules={RULES} value={null} subtitle="Kim Jiho" onDone={() => setOpen(false)} onCancel={() => setOpen(false)} />}
      <output id="open">{open ? "open" : "closed"}</output>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<QueryClientProvider client={client}><Fixture /></QueryClientProvider>);
