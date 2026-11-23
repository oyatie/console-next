// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { loadCatalog, t } from "@console/i18n";
import { bindAnnouncer } from "../../../lib/react/announce";
import { QueryState } from "../../../lib/react/query-state";
import { Field, TextInput } from "../../../ui/field/field";
import { approvalDocumentQuery } from "../api";
import { ApprovalDocumentView, ApprovalViewerPage } from "./approval-viewer";
import { ApprovalInboxView, ApprovalsPage } from "./approvals-page";
import "../../../app.css";

await loadCatalog("ko");
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const host = new URLSearchParams(location.search).get("host") ?? "page";
// The shell's live region is not drawn here: what it is given last is kept on the body for the test to read.
bindAnnouncer(text => { document.body.dataset.announced = text; });

/**
 * The baseline hosts of the decision: the document on a page of its own (`page`), or in the record column of the
 * inbox. A find box stands above it, like the one the inbox keeps beside an open document. The list of `all` keeps
 * the document's row whatever is decided. `pending` is the pending box: it drops a document once that offers no
 * decision, and holds one more row. `last` is a pending box with no other row.
 */
export function Baseline() {
  const q = useQuery({ ...approvalDocumentQuery("approval-1"), refetchOnMount: "always" });
  const [sel, setSel] = useState<string | undefined>("approval-1");
  const record = <QueryState q={q} layout="record">{document => <ApprovalDocumentView document={document} />}</QueryState>;
  const items = q.data ? [
    ...(host !== "all" && q.data.my_actions.kind === "none" ? [] : [q.data]),
    ...(host === "pending" ? [{ ...q.data, id: "approval-2", title: "Purchase request" }] : []),
  ] : [];
  return <>
    <p>{t("approvals.title")}</p>
    <Field label={t("approvals.filters.search")} required={null}>{props => <TextInput {...props} />}</Field>
    {host === "page" ? record : <ApprovalInboxView items={items} sel={sel} selected={q.data} record={sel && record} onSelect={setSel} onClose={() => setSel(undefined)} onFind={() => document.querySelector("input")?.focus()} />}
  </>;
}

// The Console hosts are the app's own pages under the routes they read: the inbox with the document chosen in the
// address (`console`) or opened by the inbox itself (`console-auto`), and the document's own page (`console-page`).
if (host.startsWith("console")) document.documentElement.dataset.experience = "console";
const root = createRootRoute({ component: Outlet });
const app = createRoute({ getParentRoute: () => root, id: "app", component: Outlet });
const routes = [
  createRoute({ getParentRoute: () => root, path: "/", component: Baseline }),
  app.addChildren([
    createRoute({ getParentRoute: () => app, path: "/approvals", validateSearch: (search: Record<string, unknown>) => ({ sel: typeof search.sel === "string" ? search.sel : undefined }), component: ApprovalsPage }),
    createRoute({ getParentRoute: () => app, path: "/approvals/$approvalId", component: ApprovalViewerPage }),
  ]),
  // The document links to its source record; the link needs its route to exist.
  createRoute({ getParentRoute: () => root, path: "/org/changes/$id", component: () => null }),
];
const start = host === "console-auto" ? "/approvals" : host === "console" ? "/approvals?sel=approval-1" : host === "console-page" ? "/approvals/approval-1" : "/";
const router = createRouter({ routeTree: root.addChildren(routes), history: createMemoryHistory({ initialEntries: [start] }) });
createRoot(document.getElementById("root")!).render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>);
