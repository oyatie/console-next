// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider, QueryObserver } from "@tanstack/react-query";
import { beforeAll, expect, test, vi } from "vitest";
import { loadCatalog } from "@console/i18n";
import { get } from "../../../lib/query";
import { filingsQuery, type FilingTask } from "../../../reference/statutory/api";
import { FilingComplete } from "./filing-complete";
import { FilingList } from "./filing-list";

const command = vi.hoisted(() => ({ send: undefined as undefined | ((input: FilingTask) => void) }));
vi.mock("../../../lib/react/command", async (original) => {
  const actual = await original<typeof import("../../../lib/react/command")>();
  return { ...actual, useCommand: (...args: Parameters<typeof actual.useCommand>) => {
    const value = actual.useCommand(...args);
    command.send = (input) => value.mutate(input);
    return value;
  } };
});
vi.mock("../../../reference/statutory/api", async (original) => ({
  ...await original<typeof import("../../../reference/statutory/api")>(), recordFiling: async () => ({}),
}));
vi.mock("../../../ui/dialog", () => ({ Dialog: () => null }));
beforeAll(() => loadCatalog("ko"));

test.each(["complete", "undo"])("filing %s refreshes its filing and trail without waiting for unrelated employee reads", async (kind) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const changed = [filingsQuery({}), get("/api/v1/lifecycle-cases/{id}", { params: { path: { id: "case" } } }),
    get("/api/v1/employees/{id}/lifecycle-cases", { params: { path: { id: "person" } } }), get("/api/v1/me/action-inbox")];
  const unrelated = vi.fn(async () => ({}));
  const observers = [...changed.map((q) => ({ ...q, queryFn: vi.fn(async () => ({})) })),
    { ...get("/api/v1/employees/{id}/personal-facts", { params: { path: { id: "person" } } }), queryFn: unrelated }]
    .map((q) => ({ fetch: q.queryFn, unsubscribe: new QueryObserver<object>(client, { ...q, initialData: {}, staleTime: Infinity }).subscribe(() => {}) }));
  const task = { event_id: "event", kind: "ACQUIRE", insurer: "NPS", applicability_facts: {}, loss_options: [] } as unknown as FilingTask;
  const done = vi.fn();
  try {
    renderToStaticMarkup(<QueryClientProvider client={client}>{kind === "complete" ? <FilingComplete task={task} onClose={() => {}} onDone={done} /> : <FilingList workplaces={{ data: {}, isPending: false, error: null, refetch: vi.fn() }} />}</QueryClientProvider>);
    command.send!(task);
    await vi.waitFor(() => { for (const observer of observers.slice(0, changed.length)) expect(observer.fetch).toHaveBeenCalledOnce(); });
    expect(unrelated).not.toHaveBeenCalled();
    if (kind === "complete") await vi.waitFor(() => expect(done).toHaveBeenCalledOnce());
  } finally {
    observers.forEach((observer) => observer.unsubscribe());
    client.clear();
  }
});
