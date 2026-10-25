// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider, QueryObserver } from "@tanstack/react-query";
import { beforeAll, expect, test, vi } from "vitest";
import { loadCatalog } from "@console/i18n";
import { get } from "../../../lib/query";
import { lifecycleCaseQuery, lifecycleCasesQuery, type CaseItem } from "../api/lifecycle-trail";
import { CaseCloseAction } from "./lifecycle-trail-action";
import { AttestSheet } from "./lifecycle-trail-attest";

const command = vi.hoisted(() => ({ send: undefined as undefined | (() => void) }));
vi.mock("../../../lib/react/command", async (original) => {
  const actual = await original<typeof import("../../../lib/react/command")>();
  return { ...actual, useCommand: (...args: Parameters<typeof actual.useCommand>) => {
    const value = actual.useCommand(...args);
    command.send = () => value.mutate(undefined);
    return value;
  } };
});
vi.mock("../api/lifecycle-trail", async (original) => ({
  ...await original<typeof import("../api/lifecycle-trail")>(),
  closeLifecycleCase: async () => ({}), completeCaseItem: async () => ({}),
}));
vi.mock("../../../ui/override-sheet/override-sheet", () => ({ OverrideSheet: () => null }));
beforeAll(() => loadCatalog("ko"));

test.each(["close", "attest"])("%s refreshes the case, case lists and inbox without re-reading unrelated employee facts", async (kind) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const changed = [lifecycleCaseQuery("case"), lifecycleCasesQuery("person"), get("/api/v1/me/action-inbox")];
  const unchanged = [get("/api/v1/employees"), get("/api/v1/employees/{id}", { params: { path: { id: "person" } } }),
    get("/api/v1/employees/{id}/contracts"), get("/api/v1/employees/{id}/personal-facts"), get("/api/v1/employees/{id}/register-facts"),
    get("/api/v1/employees/{id}/lifecycle-events"), get("/api/v1/statutory/insurance-filings")];
  const reads = [...changed, ...unchanged].map((descriptor) => {
    const fetch = vi.fn(async () => ({}));
    const observer = new QueryObserver<object>(client, { ...descriptor, queryFn: fetch, initialData: {}, staleTime: Infinity });
    return { fetch, unsubscribe: observer.subscribe(() => {}) };
  });
  try {
    renderToStaticMarkup(<QueryClientProvider client={client}>{kind === "close" ? <CaseCloseAction id="case" /> : <AttestSheet caseId="case" item={{ id: "item" } as CaseItem} onClose={() => {}} />}</QueryClientProvider>);
    command.send!();
    await vi.waitFor(() => { for (const read of reads.slice(0, changed.length)) expect(read.fetch).toHaveBeenCalledOnce(); });
    for (const read of reads.slice(changed.length)) expect(read.fetch).not.toHaveBeenCalled();
  } finally {
    reads.forEach((read) => read.unsubscribe());
    client.clear();
  }
});
