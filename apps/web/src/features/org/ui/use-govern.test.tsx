import { QueryClient, QueryClientProvider, QueryObserver } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, expect, test, vi } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import { bindAnnouncer } from "../../../lib/react/announce";
import { todayKst } from "../../../lib/pure/today";
import { read } from "../../../lib/query";
import { useGovern, useGovernSubmit, type GovernState } from "./use-govern";

const { navigate, receipt, governed } = vi.hoisted(() => ({
  navigate: vi.fn(),
  receipt: vi.fn(),
  governed: vi.fn(async () => ({ id: "change", code: "change-code", sent: "sent", select: "new-unit" })),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));
vi.mock("../api", async () => ({ governed, orgPolicyQuery: (await import("../../../lib/query")).read("/api/v1/settings", async () => ({ items: [] })) }));
vi.mock("../../../reference/org/ui/use-change-note", () => ({ noteChange: receipt }));

beforeAll(() => loadCatalog("ko"));

test("a governed change keeps its sheet pending until the changed chart has been read", async () => {
  const announced = vi.fn();
  const unbind = bindAnnouncer(announced);
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
    expect(announced).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith({ to: "/org", search: { sel: "new-unit" } });
  } finally {
    unbind();
    unsubscribe();
    client.clear();
  }
});

test("useGovern defaults effective date (적용일) to today so only reason remains missing", () => {
  expect(t("orgUnit.gov.date")).toBe("적용일");
  expect(t("orgPropose.field.date")).toBe("적용일");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Probe() {
    const gov = useGovern();
    return <output data-date={gov.g.date}>{gov.missing.join("|")}</output>;
  }
  const html = renderToStaticMarkup(<QueryClientProvider client={client}><Probe /></QueryClientProvider>);
  client.clear();
  expect(html).toBe(`<output data-date="${todayKst()}">${t("orgUnit.gov.missingReason")}</output>`);
});
