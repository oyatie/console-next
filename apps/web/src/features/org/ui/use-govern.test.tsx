import { QueryClient, QueryClientProvider, QueryObserver } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, expect, test, vi } from "vitest";
import { loadCatalog } from "@console/i18n";
import { read } from "../../../lib/query";
import { useGovernSubmit, type GovernState } from "./use-govern";

const { navigate, receipt, governed } = vi.hoisted(() => ({
  navigate: vi.fn(),
  receipt: vi.fn(),
  governed: vi.fn(async () => ({ id: "change", code: "change-code", sent: "sent" })),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));
vi.mock("../api", () => ({ governed }));
vi.mock("../../../reference/org/ui/use-change-note", () => ({ noteChange: receipt }));

beforeAll(() => loadCatalog("ko"));

test("a governed change keeps its sheet pending until the changed chart has been read", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  let finishRead!: (value: string[]) => void;
  const reread = vi.fn(() => new Promise<string[]>((resolve) => { finishRead = resolve; }));
  const chart = new QueryObserver(client, {
    ...read("/api/v1/org-structure", reread),
    initialData: ["existing department"],
    staleTime: Infinity,
  });
  const unsubscribe = chart.subscribe(() => undefined);
  let command!: ReturnType<typeof useGovernSubmit>;
  const state: GovernState = {
    g: { date: "2026-10-10", reason: "new department" },
    set: () => undefined,
    today: "2026-10-10",
    missing: [],
    late: false,
    routed: false,
    mode: "apply",
    words: { submit: () => "" },
  };
  function Probe({ collect }: { collect: (value: ReturnType<typeof useGovernSubmit>) => void }) {
    collect(useGovernSubmit(() => ({ kind: "NEW", target: { kind: "ORG_UNIT", ref: "parent", label: "new department" }, proposal: [] }), state));
    return null;
  }
  renderToStaticMarkup(<QueryClientProvider client={client}><Probe collect={(value) => { command = value; }} /></QueryClientProvider>);
  try {
    const completed = command.mutateAsync(true);
    await vi.waitFor(() => expect(reread).toHaveBeenCalledOnce());
    expect(client.getMutationCache().getAll()[0]!.state.status).toBe("pending");
    expect(receipt).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    finishRead(["new department", "existing department"]);
    await completed;
    expect(chart.getCurrentResult().data).toEqual(["new department", "existing department"]);
    expect(receipt).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith({ to: "/org", search: { sel: "parent" } });
  } finally {
    unsubscribe();
    client.clear();
  }
});
