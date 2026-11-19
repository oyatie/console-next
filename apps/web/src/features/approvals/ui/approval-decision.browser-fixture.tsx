// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { loadCatalog, t } from "@console/i18n";
import { QueryState } from "../../../lib/react/query-state";
import { Field, TextInput } from "../../../ui/field/field";
import { approvalDocumentQuery } from "../api";
import { ApprovalDocumentView } from "./approval-viewer";
import { ApprovalInboxView } from "./approvals-page";
import "../../../app.css";

await loadCatalog("ko");
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const inbox = new URLSearchParams(location.search).get("inbox");
/**
 * The document as its two hosts read and draw it: on a page of its own, or (`?inbox=`) in the record column of the
 * inbox. A find box stands above it, like the one the inbox keeps beside an open document. The list of `?inbox=all`
 * keeps the document's row whatever is decided. `?inbox=pending` is the pending box: it drops a document once that
 * offers no decision, and holds one more row. `?inbox=last` is a pending box with no other row.
 */
export function Fixture() {
  const q = useQuery({ ...approvalDocumentQuery("approval-1"), refetchOnMount: "always" });
  const [sel, setSel] = useState<string | undefined>("approval-1");
  const record = <QueryState q={q} layout="record">{document => <ApprovalDocumentView document={document} />}</QueryState>;
  const items = q.data ? [
    ...(inbox !== "all" && q.data.my_actions.kind === "none" ? [] : [q.data]),
    ...(inbox === "pending" ? [{ ...q.data, id: "approval-2", title: "Purchase request" }] : []),
  ] : [];
  return <>
    <p>{t("approvals.title")}</p>
    <Field label={t("approvals.filters.search")} required={null}>{props => <TextInput {...props} />}</Field>
    {inbox ? <ApprovalInboxView items={items} sel={sel} selected={q.data} record={sel && record} onSelect={setSel} onClose={() => setSel(undefined)} onFind={() => document.querySelector("input")?.focus()} /> : record}
  </>;
}
const root = createRootRoute({ component: Fixture });
// The column links to the source record; the link needs its route to exist.
const source = createRoute({ getParentRoute: () => root, path: "/org/changes/$id", component: () => null });
const router = createRouter({ routeTree: root.addChildren([source]), history: createMemoryHistory({ initialEntries: ["/"] }) });
createRoot(document.getElementById("root")!).render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>);
