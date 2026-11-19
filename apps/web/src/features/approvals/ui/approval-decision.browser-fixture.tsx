// SPDX-License-Identifier: LicenseRef-Proprietary
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
const column = new URLSearchParams(location.search).get("host") === "column";
const nothing = () => {};
/**
 * The document as its two hosts read and draw it: on a page of its own, or (`?host=column`) in the record column of
 * the inbox. A find box stands above it, like the one the inbox keeps beside an open document.
 */
export function Fixture() {
  const q = useQuery({ ...approvalDocumentQuery("approval-1"), refetchOnMount: "always" });
  const record = <QueryState q={q} layout="record">{document => <ApprovalDocumentView document={document} />}</QueryState>;
  return <>
    <p>{t("approvals.title")}</p>
    <Field label={t("approvals.filters.search")} required={null}>{props => <TextInput {...props} />}</Field>
    {column ? <ApprovalInboxView items={q.data ? [q.data] : []} sel="approval-1" selected={q.data} record={record} onSelect={nothing} onClose={nothing} /> : record}
  </>;
}
const root = createRootRoute({ component: Fixture });
// The column links to the source record; the link needs its route to exist.
const source = createRoute({ getParentRoute: () => root, path: "/org/changes/$id", component: () => null });
const router = createRouter({ routeTree: root.addChildren([source]), history: createMemoryHistory({ initialEntries: ["/"] }) });
createRoot(document.getElementById("root")!).render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>);
