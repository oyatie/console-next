// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { keepPreviousData, QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { loadCatalog, t } from "@console/i18n";
import { configure } from "@console/api";
import { get, read } from "../query";
import { PageReadGate } from "../../reference/authz/ui/access-gate";
import { QueryState } from "./query-state";
import { Button } from "../../ui/button/button";
import { TextArea } from "../../ui/field/text-area";
import { Field } from "../../ui/field/field";

await loadCatalog("ko");
configure({ baseUrl: location.origin, refresh: { kind: "cookie" }, passkeys: { get: async () => null, create: async () => null } });
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
function Draft({ reason }: { reason: string }) {
  const [draft, setDraft] = useState(reason);
  return <Field label={t("orgChange.reason")} required={null}>{p => <TextArea {...p} value={draft} onChange={e => setDraft(e.target.value)} />}</Field>;
}
export default function Record() {
  const [filter, setFilter] = useState(0);
  const record = get("/api/v1/org-changes/{id}", { params: { path: { id: "record" } } });
  const q = useQuery({ ...read("/api/v1/org-changes/record", record.queryFn, filter), placeholderData: keepPreviousData });
  if (new URL(location.href).searchParams.has("page-gate")) return <>
    <Button onClick={() => setFilter(n => n + 1)}>{t("common.back")}</Button>
    <PageReadGate q={q}>
      <Button onClick={() => void q.refetch()}>{t("common.retry")}</Button>
      <QueryState q={q}>{d => <Draft reason={d.reason} />}</QueryState>
    </PageReadGate>
  </>;
  return <>
    <Button onClick={() => setFilter(n => n + 1)}>{t("common.back")}</Button>
    <Button onClick={() => void q.refetch()}>{t("common.retry")}</Button>
    <QueryState q={q} keepOnLoss>{d => <Draft reason={d.reason} />}</QueryState>
  </>;
}
const router = createRouter({ routeTree: createRootRoute({ component: Record }), history: createMemoryHistory() });
createRoot(document.getElementById("root")!).render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>);
