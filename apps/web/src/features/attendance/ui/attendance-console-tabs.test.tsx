// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, beforeEach, expect, test, vi } from "vitest";
// oxlint-disable-next-line no-restricted-imports -- A refused day read is a transport refusal.
import { ApiError } from "@console/api";
import { loadCatalog, t } from "@console/i18n";
import { refusalText } from "../present";
import { CalendarView } from "./calendar-view";
import { CloseConsoleView } from "./close-console-view";
import { DayConsoleView } from "./day-console-view";
import { HolidaysView } from "./holidays-view";
import { IssuesConsoleView } from "./issues-console-view";
import { OvertimeConsoleView } from "./overtime-console-view";
import { PersonCard } from "./person-card";
import { PublicHolidaysView } from "./public-holidays-view";
import { ScheduleConsoleView } from "./schedule-console-view";

const state = vi.hoisted(() => ({
  search: { date: "2026-11-16", month: "2026-11", person: "e1" } as Record<string, unknown>,
  experience: "console" as "baseline" | "console",
  refuseDay: false,
}));

vi.mock("@tanstack/react-router", () => ({
  getRouteApi: () => ({ useSearch: () => state.search, useNavigate: () => vi.fn() }),
  Link: ({ children, to, className }: { children: ReactNode; to: string; className?: string }) => (
    <span data-href={to} className={className}>
      {children}
    </span>
  ),
}));

vi.mock("../../../ui/patterns/pattern-shell", async original => {
  const actual = await original<typeof import("../../../ui/patterns/pattern-shell")>();
  return {
    ...actual,
    ExperienceSwitch: ({ baseline, children }: { baseline: () => ReactNode; children: () => ReactNode }) => (
      <>{state.experience === "baseline" ? baseline() : children()}</>
    ),
  };
});

vi.mock("../../../experience/dom", () => ({
  useActiveExperienceId: () => state.experience,
}));

vi.mock("./scope-picker", () => ({ ScopePicker: () => null }));
vi.mock("./day-row", () => ({ DayRow: () => <div data-row="day" /> }));

vi.mock("@tanstack/react-query", async original => {
  const actual = await original<typeof import("@tanstack/react-query")>();
  return {
    ...actual,
    useInfiniteQuery: () => ({
      isPending: false,
      error: null,
      hasNextPage: false,
      isFetchingNextPage: false,
      fetchNextPage: vi.fn(),
      refetch: vi.fn(),
      data: {
        pages: [
          {
            total: 1,
            items: [
              {
                id: "exc-1",
                code: "EXC-01",
                kind: "LATE",
                status: "OPEN",
                employee_id: "e1",
                employee_name: "Hajun Yun",
                work_date: "2026-11-16",
                occurred_at: "2026-11-16T00:30:00Z",
                detail: "Late 30m",
                evidence: [],
                created_at: "2026-11-16T01:00:00Z",
              },
            ],
          },
        ],
      },
    }),
    useQuery: (opts: Record<string, unknown>) => {
      const first = Object.values(opts).find(Array.isArray);
      const path = String(first?.[0] ?? "");
      if (path.includes("/api/v1/attendance/week52")) {
        return {
          isPending: false,
          error: null,
          refetch: vi.fn(),
          data: {
            week_start: "2026-11-16",
            items: [
              {
                employee_id: "e1",
                name: "Hajun Yun",
                week_start: "2026-11-16",
                current_hours: 44,
                projected_hours: 48,
                recognized_hours: 44,
                overtime_hours: 4,
                tone: "WARN",
                acked: false,
                team: "Prod Team 1",
              },
            ],
          },
        };
      }
      if (path.includes("/api/v1/attendance/closes")) {
        return {
          isPending: false,
          error: null,
          refetch: vi.fn(),
          data: {
            items: [
              {
                branch_scope: "wp-1",
                closed: false,
                open_exceptions: 1,
                pending_leave: 2,
              },
            ],
          },
        };
      }
      // The phase line reads the access answer the page waits for; the user read may still be in flight.
      if (path === "/api/v1/access/me") {
        return { isPending: false, error: null, refetch: vi.fn(), data: { phase: "OPERATING", is_ops: false, entries: [] } };
      }
      if (path.includes("/api/v1/attendance/days") && state.refuseDay) {
        return { isPending: false, error: new ApiError(403, "forbidden", "", [], "ref-day"), refetch: vi.fn(), data: undefined };
      }
      if (path.includes("/api/v1/attendance/holidays")) {
        return { isPending: false, error: null, refetch: vi.fn(), data: { year: 2026, loaded: true, public: [], contractual: [] } };
      }
      if (path.includes("/api/v1/attendance/days")) {
        return {
          isPending: false,
          error: null,
          refetch: vi.fn(),
          data: {
            date: "2026-11-16",
            judged: true,
            marks: { blocking: 1, decision: 0 },
            issue_groups: [],
            ledger: { people: 1, no_schedule: 0, rest: 0, no_record: 0, missing_out: 0, absent: 0, outside: 0, trip: 0, late_or_early: 0, normal: 1, pending: 0 },
            groups: [
              {
                workplace_id: "wp-1",
                unit_id: "d1",
                name: "Prod Team 1",
                people: 1,
                normal: 1,
                no_schedule: 0,
                hidden: 0,
                marks: { blocking: 0, decision: 0 },
                rows: [
                  {
                    employee_id: "e1",
                    name: "Hajun Yun",
                    month_state: { state: "OPEN" },
                    own: false,
                    day: { recognition: { recognised: 480 }, marks: [], plan: { kind: "WORK" } },
                  },
                ],
              },
            ],
          },
        };
      }
      if (path.includes("/api/v1/attendance/schedule/tree")) {
        return {
          isPending: false,
          error: null,
          refetch: vi.fn(),
          data: {
            date: "2026-11-16",
            people_total: 12,
            people_unscheduled: 0,
            holidays_loaded: true,
            nodes: [],
          },
        };
      }
      if (path.includes("/api/v1/attendance/patterns")) {
        return { isPending: false, error: null, refetch: vi.fn(), data: { items: [{ id: "pat-1", status: "ACTIVE" }] } };
      }
      if (path.includes("/api/v1/attendance/schedule/layers")) {
        return { isPending: false, isFetched: true, error: null, refetch: vi.fn(), data: { items: [] } };
      }
      if (path.includes("/api/v1/attendance/schedule/calendar")) {
        return {
          isPending: false,
          error: null,
          refetch: vi.fn(),
          data: { month: "2026-11", scope_kind: "WORKPLACE", scope_id: "wp-1", scope_name: "Plant", stack: [], upcoming: [], days: [], holidays_loaded: true },
        };
      }
      if (path.includes("/api/v1/attendance/people/")) {
        return {
          isPending: false,
          error: null,
          refetch: vi.fn(),
          data: {
            employee_id: "e1",
            name: "Hajun Yun",
            employee_number: "10587",
            month_state: { state: "OPEN" },
            provisional: true,
            totals: { recognised: 480, overtime: 0, night: 0, holiday: 0 },
            days: [{ date: "2026-11-16", plan: { kind: "WORK" }, recognition: { recognised: 480 }, marks: [] }],
            history: [],
          },
        };
      }
      if (path.startsWith("/api/v1/access/")) return { isPending: true, error: null, refetch: vi.fn(), data: undefined };
      return { isPending: false, error: null, refetch: vi.fn(), data: [] };
    },
  };
});

beforeAll(() => loadCatalog("ko"));
beforeEach(() => {
  state.search = { date: "2026-11-16", month: "2026-11", person: "e1" };
  state.experience = "console";
  state.refuseDay = false;
});

function render(node: ReactNode) {
  const qc = new QueryClient();
  return renderToStaticMarkup(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

test("overtime console renders week52 rows without contrary approved-overtime legend", () => {
  const html = render(<OvertimeConsoleView baseline={() => <div data-base />} />);
  expect(html).toContain("Hajun Yun");
  expect(html).toContain(t("attendance.overtime.line"));
  expect(html).toContain(t("attendance.overtime.WARN"));
  expect(html).not.toContain(t("attendance.monthConsole.grid.footer.approvedOvertime"));
});

test("issues, close, day, schedule console views and person card render without crashing", () => {
  expect(render(<IssuesConsoleView baseline={() => <div />} />)).toContain("Hajun Yun");
  expect(render(<CloseConsoleView baseline={() => <div />} />)).toContain(t("attendance.tab.close"));
  expect(render(<DayConsoleView baseline={() => <div />} />)).toContain("Prod Team 1");
  expect(render(<ScheduleConsoleView baseline={() => <div />} />)).toContain(t("attendance.view.calendar"));
  expect(render(<PersonCard id="e1" month="2026-11" head={null} />)).toContain("Hajun Yun");
});

test("person card falls back cleanly to baseline when baseline experience is active", () => {
  state.experience = "baseline";
  const html = render(<PersonCard id="e1" month="2026-11" head={null} />);
  expect(html).toContain("Hajun Yun");
  expect(html).toContain(t("attendanceRecords.card.daysTitle"));
});

const tree = { date: "2026-11-16", people_total: 12, people_unscheduled: 0, holidays_loaded: true, nodes: [{ id: "wp-1", kind: "WORKPLACE", name: "Plant", people: 12, unscheduled: 0 }] } as never;
const jump = (key: Parameters<typeof t>[0]) => `>${t(key)}</button>`;

// A style never drops behaviour: Classic's steppers carry the jump back to the current period.
test.each([
  ["issues", () => <IssuesConsoleView baseline={() => null} />, "attendance.period.thisMonth"],
  ["close", () => <CloseConsoleView baseline={() => null} />, "attendance.period.thisMonth"],
  ["day", () => <DayConsoleView baseline={() => null} />, "uiDate.today"],
  ["overtime", () => <OvertimeConsoleView baseline={() => null} />, "attendance.period.thisWeek"],
  ["calendar", () => <CalendarView consoleMode tree={tree} search={{ month: "2026-11" }} onScope={vi.fn()} onMonth={vi.fn()} onAssign={vi.fn()} onCancel={vi.fn()} onAddPattern={vi.fn()} />, "attendance.period.thisMonth"],
  ["company holidays", () => <HolidaysView consoleMode tree={tree} onDone={vi.fn()} />, "attendance.period.thisYear"],
  ["public holidays", () => <PublicHolidaysView consoleMode />, "attendance.period.thisYear"],
] as const)("the Console %s stepper keeps the jump to the current period", (_, view, key) => {
  expect(render(view())).toContain(jump(key));
});

test("the Console month close grid opens a scope from its row, with no actions column or row button", () => {
  const html = render(<CloseConsoleView baseline={() => null} />);
  expect(html).toContain("wp-1");
  expect(html).not.toContain(t("settingsHub.reasons.actionsCol"));
  const grid = html.slice(html.indexOf('role="grid"'));
  // The row itself carries the open action: React Aria marks an actionable row pressable.
  expect(grid).toMatch(/role="row"[^>]*data-react-aria-pressable="true"[^>]*data-row-id="wp-1"/);
  expect(grid).not.toContain("<button");
});

test("a refused Console day board names the server's refusal inside its disclosure", () => {
  state.refuseDay = true;
  const html = render(<DayConsoleView baseline={() => null} />);
  expect(html).toContain(t("common.denied.title.plain"));
  expect(html).toContain(refusalText("forbidden")!);
});

test("the Console person card says when the month has no record history", () => {
  expect(render(<PersonCard id="e1" month="2026-11" head={null} />)).toContain(t("attendanceRecords.day.noHistory"));
});

test.each([
  ["issues", () => <IssuesConsoleView baseline={() => null} />],
  ["close", () => <CloseConsoleView baseline={() => null} />],
  ["day", () => <DayConsoleView baseline={() => null} />],
  ["overtime", () => <OvertimeConsoleView baseline={() => null} />],
  ["schedule", () => <ScheduleConsoleView baseline={() => null} />],
] as const)("the Console %s head keeps the tenant phase line Classic draws beside the title", (_, view) => {
  expect(render(view())).toContain(t("attendance.phase.operating"));
});

test("the Console calendar puts its assign command in the stepper row, above the month and its history", () => {
  const html = render(<CalendarView consoleMode tree={tree} search={{ month: "2026-11" }} onScope={vi.fn()} onMonth={vi.fn()} onAssign={vi.fn()} onCancel={vi.fn()} onAddPattern={vi.fn()} />);
  const assign = html.indexOf(t("attendanceSchedule.assign.open"));
  expect(assign).toBeGreaterThan(-1);
  expect(assign).toBeLessThan(html.indexOf("<table"));
  expect(assign).toBeLessThan(html.indexOf(t("attendanceSchedule.history.title")));
});
