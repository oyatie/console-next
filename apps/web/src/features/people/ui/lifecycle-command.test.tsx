// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider, QueryObserver } from "@tanstack/react-query";
import { expect, test, vi } from "vitest";
import type { components } from "@console/api/schema";
import { read } from "../../../lib/query";
import { useExitCommand } from "./use-exit-command";
import { useLifecycleCommand } from "./use-lifecycle-command";
import { EMPTY } from "./use-lifecycle-draft";

type Case = components["schemas"]["EmployeeExitCase"];
const recorded = { id: "exit-case", hr_confirmed_at: "2026-10-25T00:00:00Z", hr_confirmed_by: "admin" } as Case;
vi.mock("../api", async (original) => ({
  ...await original<typeof import("../api")>(),
  recordLifecycleEvent: async () => ({ id: "event" }),
  caseQuery: () => ({ queryFn: async () => recorded }),
  mySub: () => "admin",
}));

function heldRead(client: QueryClient, path: string) {
  let release!: () => void;
  const fetch = vi.fn(() => new Promise<object>((resolve) => { release = () => resolve({}); }));
  const descriptor = read(path, fetch, { path: { id: "person" } });
  const observer = new QueryObserver(client, { ...descriptor, initialData: {}, staleTime: Infinity });
  const unsubscribe = observer.subscribe(() => {});
  return { read: fetch, descriptor, release: () => release?.(), unsubscribe };
}

test.each(["exit", "exit lookup", "lifecycle"])("%s confirmation waits for its record, without waiting for the employee trail", async (kind) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const own = heldRead(client, kind === "lifecycle" ? "/api/v1/employees/{id}/lifecycle-events" : "/api/v1/hr/exit-cases");
  const trail = heldRead(client, "/api/v1/employees/{id}/lifecycle-cases");
  const candidates = heldRead(client, "/api/v1/appointment-notices/candidates");
  const done = vi.fn();
  let send!: () => void;
  function Probe({ collect }: { collect: (send: () => void) => void }) {
    const exit = useExitCommand({
      caseId: recorded.id, check: kind === "exit lookup" ? "confirm_exit" : "resend",
      run: async () => recorded,
      onSuccess: done,
    });
    const lifecycle = useLifecycleCommand({ employeeId: "person", kind: "CONTRACT_RENEWAL", pin: 1 }, EMPTY, done);
    collect(() => kind === "lifecycle" ? lifecycle.mutate(undefined) : kind === "exit lookup" ? exit.checkNow() : exit.submit(undefined));
    return null;
  }
  renderToStaticMarkup(<QueryClientProvider client={client}><Probe collect={(value) => { send = value; }} /></QueryClientProvider>);
  try {
    send();
    await vi.waitFor(() => { expect(own.read).toHaveBeenCalledOnce(); expect(trail.read).toHaveBeenCalled(); });
    if (kind === "lifecycle") expect(candidates.read).toHaveBeenCalledOnce();
    expect(done).not.toHaveBeenCalled();
    own.release();
    await vi.waitFor(() => expect(done).toHaveBeenCalledTimes(1));
    expect(client.isFetching(trail.descriptor)).toBe(1);
  } finally {
    own.release(); trail.release(); candidates.release(); own.unsubscribe(); trail.unsubscribe(); candidates.unsubscribe(); client.clear();
  }
});
