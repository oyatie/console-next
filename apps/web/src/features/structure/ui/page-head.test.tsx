// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import { ApiError } from "../../../reference/authz/api";
import { loadCatalog, t } from "@console/i18n";
import { queryPath } from "../../../lib/query";
import { buildStructure, type Structure } from "../domain/model";
import { StructurePage } from "./structure-page";

const state = vi.hoisted(() => ({
  s: undefined as Structure | undefined,
  error: null as unknown,
  refetch: vi.fn(),
  dates: { data: undefined as { items: string[] } | undefined, error: null as unknown, status: "error", fetchStatus: "idle", isSuccess: false, isError: true, isFetching: false, isFetchedAfterMount: true, refetch: vi.fn() },
}));
vi.mock("@tanstack/react-router", () => ({
  getRouteApi: () => ({ useSearch: () => ({}), useNavigate: () => vi.fn() }),
  useNavigate: () => vi.fn(),
  Link: ({ to, children }: { to: string; children: ReactNode }) => <span data-to={to}>{children}</span>,
}));
vi.mock("@tanstack/react-query", async original => ({
  ...await original<object>(),
  useQuery: (q: Parameters<typeof queryPath>[0]) => queryPath(q) === "/api/v1/org-structure/change-dates" ? state.dates : { isPending: true },
}));
vi.mock("../../../reference/settings/ui/use-policy-routed", () => ({ usePolicyRouted: () => false }));
vi.mock("./use-structure-commands", () => ({ useStructureCommands: (readOnly: boolean) => ({ readOnly }) }));
vi.mock("./use-structure", () => ({ useStructure: () => ({
  s: state.s, tree: { error: state.error },
  ready: { isPending: false, error: state.error, data: state.s ? true : undefined, refetch: state.refetch },
}) }));
vi.mock("./chart-view", () => ({ ChartView: ({ dimmed }: { dimmed: boolean }) => {
  const label = "last good chart";
  return <div data-dimmed={dimmed}>{label}</div>;
} }));

beforeAll(() => loadCatalog("ko"));
beforeEach(() => {
  state.s = undefined;
  state.error = new ApiError(503, "service_unavailable", "read failed", [], "structure-read-reference");
  Object.assign(state.dates, { data: undefined, error: new ApiError(503, "service_unavailable", "dates failed", [], "dates-read-reference"), status: "error", fetchStatus: "idle", isSuccess: false, isError: true, isFetching: false, isFetchedAfterMount: true });
});
const render = () => renderToStaticMarkup(<StructurePage fixLink={() => null} proposal={null} panel={() => null} sheets={null} />);
const retain = () => {
  state.s = buildStructure({ tenant_name: "조직", phase: "OPERATING", entities: [], unplaced: [] });
  state.s.root.children.push({ id: "entity", kind: "entity", name: "법인", headcount: 0, chips: [], depth: 1, children: [] });
};

test("failed change dates never claim previous, next or history is empty; one page error carries the reference", () => {
  const html = render();
  for (const key of ["asof.noPrevious", "asof.noNext", "asof.noChanges"] as const) expect(html).not.toContain(t(key));
  expect(html.match(/role="alert"/g)).toHaveLength(1);
  expect(html.split(t("common.retry"))).toHaveLength(2);
  expect(html).not.toContain(t("asof.retry"));
  expect(html).toContain("structure-read-reference");
});

test("a cold structure failure shares one reason for dependent actions", () => {
  const html = render();
  for (const key of ["orgChange.chip.history", "structure.import.label", "structure.export.open", "asof.compare"] as const) {
    expect(html).toMatch(new RegExp(`<button[^>]*aria-disabled="true"[^>]*aria-describedby="[^"]+"[^>]*>[\\s\\S]*?${t(key)}</button>`));
  }
  expect(html.split(t("structure.readFailed"))).toHaveLength(2);
  const descriptions = [...html.matchAll(/<button[^>]*aria-disabled="true"[^>]*aria-describedby="([^"]+)"/g)].map(m => m[1]);
  expect(descriptions).toHaveLength(4);
  expect(new Set(descriptions).size).toBe(1);
  expect(html).not.toContain('data-to="/org/history"');
});

test("a cold structure failure leaves the date field and recovery controls outside inert regions", () => {
  const html = render();
  expect(html).toContain('<section aria-label="기준일"');
  expect(html).not.toContain('inert=""');
});

test("cached change dates are not presented as a successful empty answer after a failed reread", () => {
  state.dates.data = { items: [] };
  const html = render();
  expect(html).not.toContain(t("asof.noChanges"));
  expect(html).not.toContain(t("asof.noPrevious"));
  expect(html).not.toContain(t("asof.noNext"));
});

test("a failed structure reread retains and dims the chart with one retry", () => {
  retain();
  const html = render();
  expect(html).toContain('data-dimmed="true">last good chart');
  expect(html.split(t("common.retry"))).toHaveLength(2);
  expect(html).toContain("structure-read-reference");
  expect(html).toContain('data-to="/org/history"');
});

test("a change-date-only failure has one inline notice without dimming a fresh chart", () => {
  retain();
  state.error = null;
  const html = render();
  expect(html).toContain("dates-read-reference");
  expect(html).toContain('data-dimmed="false">last good chart');
  expect(html).not.toContain(t("common.read.stale"));
  expect(html).toContain(t("asof.error"));
  expect(html.split(t("common.retry"))).toHaveLength(2);
});

test("a successful empty date read still reports empty history", () => {
  retain();
  state.error = null;
  Object.assign(state.dates, { data: { items: [] }, error: null, status: "success", isSuccess: true, isError: false });
  const html = render();
  for (const key of ["asof.noPrevious", "asof.noNext", "asof.noChanges"] as const) expect(html).toContain(t(key));
  expect(html).not.toContain('role="alert"');
  expect(html).toContain('data-dimmed="false">last good chart');
});

test("pending change dates show a busy ribbon without an empty-history claim or dimming the chart", () => {
  retain();
  state.error = null;
  Object.assign(state.dates, { error: null, status: "pending", fetchStatus: "fetching", isError: false, isFetching: true, isFetchedAfterMount: false });
  const html = render();
  expect(html).toMatch(/role="group" aria-label="변경일" aria-busy="true"/);
  expect(html).not.toContain(t("asof.noChanges"));
  expect(html).not.toContain(t("common.read.stale"));
  expect(html).toContain('data-dimmed="false">last good chart');
});
