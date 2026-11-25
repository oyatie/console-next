// SPDX-License-Identifier: LicenseRef-Proprietary
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { loadCatalog } from "@console/i18n";
import { EMPTY } from "../domain/register";
import { RegisterRun } from "./register-run-page";
import { RunTable } from "./register-run-table";
import { RegisterSheet } from "./register-sheet";
import "../../../app.css";

await loadCatalog("ko");
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const params = new URLSearchParams(location.search);
const which = params.get("case");
// The style is read from the page root, where the app's boot script puts the stored one.
if (params.get("look") === "console") document.documentElement.dataset.experience = "console";
const noop = () => {};
// The run's entry row before anyone is registered, the whole run page, and the registration sheet as the roster opens it.
export function Fixture() {
  if (which === "run") return <RegisterRun />;
  return which === "table"
    ? <RunTable rows={[]} showAll={false} onShowAll={noop} d={EMPTY} set={noop} hireText="" onHire={noop} today="2026-11-19" places={[]} carried={() => false} invalid={new Set()} undoable={false} onUndo={noop} onSave={noop} />
    : <RegisterSheet onClose={noop} onOpen={noop} onRehire={noop} />;
}
const router = createRouter({ routeTree: createRootRoute({ component: Fixture }), history: createMemoryHistory({ initialEntries: ["/"] }) });
createRoot(document.getElementById("root")!).render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>);
