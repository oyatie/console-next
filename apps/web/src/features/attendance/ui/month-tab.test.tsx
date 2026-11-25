// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, beforeEach, expect, test, vi } from "vitest";
// oxlint-disable-next-line no-restricted-imports -- A refused month read is a transport refusal.
import { ApiError } from "@console/api";
import { loadCatalog, t } from "@console/i18n";
import { queryPath } from "../../../lib/query";
import { refusalText } from "../present";
import type { Drafts } from "../domain/grid";
import { MonthTab } from "./month-tab";

const state = vi.hoisted(() => ({
  cursor: 0, people: 1, drafts: {} as Drafts, receipt: false, saveDock: false,
  load: "ready" as "ready" | "loading" | "error" | "refused",
  experience: "baseline" as "baseline" | "console",
  blocking: 0,
}));
vi.mock("../../../experience/dom", async (original) => {
  const actual = await original<typeof import("../../../experience/dom")>();
  return { ...actual, useActiveExperienceId: () => state.experience };
});
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  return { ...actual, useState: (initial: unknown) => {
    const at = state.cursor++;
    if (at === 1 && state.saveDock) return [{ kind: "save" }, vi.fn()];
    if (at === 3 && state.receipt) return [{ saved: 1, opens: { blocking: 0, decision: 0 } }, vi.fn()];
    return actual.useState(initial);
  } };
});
vi.mock("@tanstack/react-router", () => ({
  getRouteApi: () => ({ useSearch: () => ({ month: "2026-10" }), useNavigate: () => vi.fn() }),
  Link: ({ children, to, className }: { children: ReactNode; to: string; className?: string }) => <span data-href={to} className={className}>{children}</span>,
}));
vi.mock("@tanstack/react-query", async original => ({ ...await original<typeof import("@tanstack/react-query")>(),
  // The head's phase line reads the access answer the page waits for; the other reads (the user's own among them) stay pending.
  useQuery: (q: Parameters<typeof queryPath>[0]) => queryPath(q) === "/api/v1/access/me"
    ? { isPending: false, error: null, data: { phase: "OPERATING", is_ops: false, entries: [] } }
    : { isPending: true, error: null, data: undefined },
  useInfiniteQuery: () => ({
  isPending: state.load === "loading", isSuccess: state.load === "ready", isError: state.load === "error" || state.load === "refused",
  error: state.load === "error" ? new Error("unavailable") : state.load === "refused" ? new ApiError(403, "forbidden", "", [], "ref-month") : null,
  data: state.load === "ready" ? { pages: [{ people_total: state.people, rows: state.people ? [
    {
      employee_id: "person",
      employee_number: "10587",
      name: "Person",
      own: false,
      month_state: { state: "OPEN" },
      totals: { recognised: 9600, approved: 120, unrecognised: 60, not_worked: 0, blocking: state.blocking, decision: 1 },
      cells: [
        { date: "2026-10-01", plan_kind: "WORK", recognised: 480, unrecognised: 0, not_worked: 0, marks: state.blocking > 0 ? ["NO_RECORD"] : [] },
        { date: "2026-10-05", plan_kind: "SUBSTITUTE_HOLIDAY", recognised: 0, unrecognised: 0, not_worked: 0, marks: [] },
      ],
    },
  ] : [] }] } : undefined,
}) }));
vi.mock("./use-drafts", () => ({ useDrafts: () => ({ drafts: state.drafts }) }));
vi.mock("./scope-picker", () => ({ ScopePicker: () => null }));
vi.mock("./month-grid-view", () => ({ MonthGridView: () => null }));
vi.mock("./save-dock", () => ({ SaveDock: () => <span data-testid="save-dock" /> }));

beforeAll(() => loadCatalog("ko"));
beforeEach(() => {
  state.cursor = 0;
  state.people = 1;
  state.drafts = {};
  state.receipt = false;
  state.saveDock = false;
  state.load = "ready";
  state.experience = "baseline";
  state.blocking = 0;
});
const render = () => renderToStaticMarkup(<MonthTab />);

test("the month toolbar offers no future approval screen", () => {
  const html = render();
  expect(html).not.toContain("승인 기록");
  expect(html).not.toContain("연장·휴일근무는 승인 기록으로만 인정됩니다 · 승인 기록 화면이 열리면 이 근무표에서 바로 기록할 수 있습니다");
});

test("the save receipt keeps undo without offering a future review queue", () => {
  state.receipt = true;
  const html = render();
  expect(html).toContain(t("attendanceRecords.receipt.undo"));
  expect(html).not.toContain("확인 필요 보기");
  expect(html).not.toContain("확인 필요 화면이 열리면 이 저장에서 생긴 항목으로 바로 갑니다 · 지금은 근무표의 ▲ ◆ 표시로 찾습니다");
});

test("populated boards keep navigation without zero-draft save controls", () => {
  const html = render();
  expect(html).toContain('role="toolbar"');
  expect(html).toContain(t("attendanceRecords.toolbar.prevMonth"));
  expect(html).not.toContain(t("attendanceRecords.toolbar.unsaved", { count: 0, refused: 0 }));
  expect(html).not.toContain(t("attendanceRecords.save.nothing"));
  expect(html).not.toContain(`>${t("attendanceRecords.toolbar.save")} `);
});

test("the first draft exposes save status and command", () => {
  state.drafts = { "person|2026-10-06": { value: "=", base: null } };
  const html = render();
  expect(html).toContain(`<span role="status">${t("attendanceRecords.toolbar.unsaved", { count: 1, refused: 0 })}</span><button`);
  expect(html).toContain(`>${t("attendanceRecords.toolbar.save")} `);
});

test("a successful empty month hides its toolbar and keeps schedule assignment", () => {
  state.people = 0;
  const html = render();
  expect(html).not.toContain('role="toolbar"');
  expect(html).toContain(t("attendanceRecords.empty.toSchedule"));
  expect(html).toContain('class="btn btn--primary"');
});

test.each(["loading", "error"] as const)("%s preserves the existing toolbar behavior", (load) => {
  state.load = load;
  expect(render()).toContain('role="toolbar"');
});

test("opening save without drafts does not mount the save dock", () => {
  state.saveDock = true;
  expect(render()).not.toContain('data-testid="save-dock"');
});

test("opening save with a draft mounts the save dock", () => {
  state.saveDock = true;
  state.drafts = { "person|2026-10-06": { value: "=", base: null } };
  expect(render()).toContain('data-testid="save-dock"');
});

test("Console P5 renders MonthGridPattern, 6 StatRow tiles, recognition basis without contrary overtime claim, and disables Month Close when blocking > 0", () => {
  state.experience = "console";
  state.blocking = 1;
  const html = render();
  expect(html).toContain('data-pattern="month-grid"');
  expect(html).toContain(t("attendanceRecords.recognition.basis"));
  expect(html).toContain(t("attendance.monthConsole.bottom.blocksClose"));
  expect(html).toContain('aria-disabled="true"');
  expect(html).toContain(t("attendance.monthConsole.summary.weekdayHolidays"));
  expect(html).toContain(t("attendance.monthConsole.filter.issues"));
  expect(html).toContain(t("attendance.monthConsole.filter.overtime"));
  expect(html).toContain(t("attendance.monthConsole.actions.reviewIssues"));
  expect(html).toMatch(new RegExp(`btn--primary[^>]*>${t("attendance.monthConsole.actions.reviewIssues")}`));
  expect(html).not.toMatch(new RegExp(`btn--primary[^>]*>${t("attendance.tab.close")}`));
});

test("Console P5 mounts SaveDock inside SidePane when save is open with drafts", () => {
  state.experience = "console";
  state.saveDock = true;
  state.drafts = { "person|2026-10-06": { value: "=", base: null } };
  const html = render();
  expect(html).toContain('data-pane="record"');
  expect(html).toContain('data-testid="save-dock"');
});

// Save takes Command or Control in the grid; the hint names the key this system's keyboard has.
test.each((["baseline", "console"] as const).flatMap(look => [[look, "Win32", "Ctrl+S"], [look, "MacIntel", "⌘S"]] as const))("%s look: on %s the save command's key hint reads %s", (look, platform, hint) => {
  state.experience = look;
  // The hint reads the navigator only inside a page, so the test stands in for both.
  vi.stubGlobal("document", {});
  vi.stubGlobal("navigator", { platform, onLine: true });
  state.drafts = { "person|2026-10-06": { value: "=", base: null } };
  try {
    expect(render()).toContain(`>${hint}</kbd>`);
  } finally {
    vi.unstubAllGlobals();
  }
});

test("Console month keeps the jump back to this month beside its month stepper", () => {
  state.experience = "console";
  expect(render()).toContain(`>${t("attendance.period.thisMonth")}</button>`);
});

test("Console month keeps the tenant phase line Classic draws beside the title", () => {
  state.experience = "console";
  expect(render()).toContain(t("attendance.phase.operating"));
});

test("a refused Console month names the server's refusal inside its disclosure", () => {
  state.experience = "console";
  state.load = "refused";
  const html = render();
  expect(html).toContain(t("common.denied.title.plain"));
  expect(html).toContain(refusalText("forbidden")!);
});
