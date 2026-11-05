// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
import type { components } from "@console/api/schema";
import { branchesQuery } from "../../../reference/org/api";
import { CloseTab } from "./close-tab";

type Row = components["schemas"]["AttendanceMonthCloseItem"];
const state = vi.hoisted(() => ({ wp: undefined as string | undefined, items: [] as Row[] }));
vi.mock("@tanstack/react-router", () => ({
  getRouteApi: () => ({ useSearch: () => ({ month: "2026-10", wp: state.wp }) }),
  Link: ({ children, to, search }: { children: ReactNode; to: string; search: Record<string, string> }) => <span data-href={`${to}?${new URLSearchParams(search)}`}>{children}</span>,
}));
vi.mock("@tanstack/react-query", () => ({ useQuery: (q: unknown) => ({
  data: q === branchesQuery ? [{ id: "branch", name: "부산사업장" }] : { month: "2026-10", items: state.items },
}) }));
vi.mock("./read-period", () => ({ ReadPeriod: () => null }));
vi.mock("../../../lib/react/query-state", () => ({ QueryState: ({ children }: { children: () => ReactNode }) => children() }));
vi.mock("../../../ui/long-table/long-table", () => ({ LongTable: ({ rows, columns }: { rows: Row[]; columns: { id: string; header: ReactNode; cell: (r: Row) => ReactNode }[] }) => <>{columns.map(c => <div key={c.id}>{c.header}{rows.map(r => <span key={r.branch_scope}>{c.cell(r)}</span>)}</div>)}</> }));

beforeAll(() => loadCatalog("ko"));
beforeEach(() => {
  state.wp = undefined;
  state.items = [{ branch_scope: "branch", closed: false, open_exceptions: 7, pending_leave: 2 }];
});
const render = () => renderToStaticMarkup(<CloseTab />);

test("workplace labels follow each served row even without a workplace filter", () => {
  expect(render()).toContain("부산사업장");
});

test.each([undefined, "branch"])("only the server's org scope uses the all-workplaces label (filter %s)", wp => {
  state.wp = wp;
  state.items[0]!.branch_scope = "org";
  expect(render()).toContain(t("attendanceRecords.scope.all", { count: 1 }));
});

test("an unknown scope stays unknown instead of being labelled all workplaces", () => {
  state.items[0]!.branch_scope = "unavailable";
  expect(render()).toContain(t("attendance.close.unavailable"));
});

test("pending leave remains separate from open exceptions", () => {
  const html = render();
  expect(html).toContain(t("attendance.close.pendingLeave"));
  expect(html).toContain(`<span>${t("attendance.count", { count: 2 })}</span>`);
  expect(html).toContain(`<span>${t("attendance.count", { count: 7 })}</span>`);
});

test("a served close exposes its timestamp and exact period-lock destination", () => {
  state.items[0] = { ...state.items[0]!, closed: true, close: {
    id: "close", month: "2026-10", branch_scope: "branch", checks: [], attested_by: "actor",
    attested_at: "2026-11-02T01:00:00Z", closed_at: "2026-11-02T01:00:00Z", period_lock_id: "lock", amendments: [],
  } };
  const html = render();
  expect(html).toContain(fmtDateTime(state.items[0]!.close!.closed_at));
  expect(html).toContain('href="/people/period-locks?unlock=lock"');
  expect(html).toContain(t("attendanceRecords.month.requestUnlock"));
});

test("missing close details or lock ids never invent a timestamp or unlock link", () => {
  state.items[0]!.closed = true;
  expect(render()).not.toContain("/people/period-locks");
  expect(render()).not.toContain("NaN");
  state.items[0]!.close = { id: "close", month: "2026-10", branch_scope: "branch", checks: [], attested_by: "actor", attested_at: "2026-11-02T01:00:00Z", closed_at: "2026-11-02T01:00:00Z", amendments: [] };
  expect(render()).not.toContain("/people/period-locks");
});
