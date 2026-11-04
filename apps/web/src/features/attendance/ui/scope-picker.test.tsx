// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import { ApiError } from "../../../reference/authz/api";
import { loadCatalog, t } from "@console/i18n";
import { AttendanceHead } from "./attendance-head";
import { CloseTab } from "./close-tab";
import { CrewsView } from "./crews-view";
import { ScopePicker } from "./scope-picker";

const state = vi.hoisted(() => ({
  tree: "ready" as "ready" | "loading" | "error",
  crews: "ready" as "ready" | "error",
  closeBoard: "ready" as "ready" | "error" | "stale",
  closeBranches: "ready" as "ready" | "error" | "stale",
  orgError: false,
}));

vi.mock("@tanstack/react-router", () => ({
  getRouteApi: () => ({ useSearch: () => ({ month: "2026-10", date: "2026-10-06" }), useNavigate: () => vi.fn() }),
  Link: (props: { children: ReactNode }) => <>{props.children}</>,
}));

const readResult = (isPending: boolean, error: ApiError | null, data: unknown) => ({
  isPending,
  error,
  data,
  refetch: () => {},
});

vi.mock("@tanstack/react-query", async importOriginal => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  return {
    ...actual,
    useQuery: (descriptor: unknown) => {
      const text = JSON.stringify(descriptor);
      const outage = new ApiError(503, "service_unavailable", "");
      if (text.includes("schedule/tree")) {
        return readResult(
          state.tree === "loading",
          state.tree === "error" ? outage : null,
          state.tree === "ready"
            ? {
                date: "2026-10-06",
                people_total: 4,
                people_unscheduled: 0,
                holidays_loaded: true,
                nodes: [
                  { id: "wp-1", kind: "WORKPLACE", name: "본사", people: 2, unscheduled: 0 },
                  { id: "wp-2", kind: "WORKPLACE", name: "지점", people: 2, unscheduled: 0 },
                ],
              }
            : undefined,
        );
      }
      if (text.includes("crews")) {
        return readResult(false, state.crews === "error" ? outage : null, state.crews === "ready" ? { items: [] } : undefined);
      }
      if (text.includes("closes")) {
        return readResult(false, state.closeBoard === "ready" ? null : outage, state.closeBoard === "error" ? undefined : { month: "2026-10", items: [] });
      }
      if (text.includes("branches")) {
        return readResult(false, state.closeBranches === "ready" ? null : outage, state.closeBranches === "error" ? undefined : [{ id: "wp-1", name: "본사" }]);
      }
      return readResult(false, state.orgError ? outage : null, { phase: "SETUP", entities: [] });
    },
  };
});

beforeAll(() => loadCatalog("ko"));
beforeEach(() => {
  state.tree = "ready";
  state.crews = "ready";
  state.closeBoard = "ready";
  state.closeBranches = "ready";
  state.orgError = false;
});

test("ScopePicker omits optional hint and never claims zero workplaces while loading or failed", () => {
  const ready = renderToStaticMarkup(<ScopePicker value={undefined} onChange={() => {}} />);
  expect(ready).not.toContain(t("uiField.optional"));
  expect(ready).toContain(t("attendanceRecords.scope.all", { count: 2 }));

  for (const mode of ["loading", "error"] as const) {
    state.tree = mode;
    const html = renderToStaticMarkup(<ScopePicker value={undefined} onChange={() => {}} />);
    expect(html).not.toContain(t("uiField.optional"));
    expect(html).not.toContain(t("attendanceRecords.scope.all", { count: 0 }));
    expect(html).toContain(">사업장 전체<");
  }
});

test("CrewsView hides its create action when the crews read fails", () => {
  const emptyTree = { date: "2026-10-06", people_total: 0, people_unscheduled: 0, holidays_loaded: true, nodes: [] };
  state.crews = "error";
  const html = renderToStaticMarkup(<CrewsView tree={emptyTree} onAssign={() => {}} onDone={() => {}} />);
  expect(html).toContain(t("common.loadFailed.title"));
  expect(html).not.toContain(t("attendanceCrews.crews.add"));
});

test("CloseTab combines closes and branches into one stale or failed read region", () => {
  state.closeBoard = "stale";
  state.closeBranches = "stale";
  const stale = renderToStaticMarkup(<CloseTab />);
  expect(stale.match(/다시 불러오기/g)).toHaveLength(1);

  state.closeBoard = "error";
  state.closeBranches = "error";
  const failed = renderToStaticMarkup(<CloseTab />);
  expect(failed.match(/role="alert"/g)).toHaveLength(1);
});

test("AttendanceHead omits cached phase metadata when orgStructureRef fails", () => {
  state.orgError = true;
  const html = renderToStaticMarkup(<AttendanceHead tab="day" />);
  expect(html).not.toContain(t("attendance.phase.setup"));
});
