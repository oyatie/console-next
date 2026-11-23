// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import { CloseConsoleView } from "./close-console-view";
import { DayConsoleView } from "./day-console-view";
import { IssuesConsoleView } from "./issues-console-view";
import { OvertimeConsoleView } from "./overtime-console-view";
import { PersonCard } from "./person-card";
import { ScheduleConsoleView } from "./schedule-console-view";

const state = vi.hoisted(() => ({
  search: { date: "2026-11-16", month: "2026-11", person: "e1" } as Record<string, unknown>,
  experience: "console" as "baseline" | "console",
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
      if (path.includes("/api/v1/attendance/month-closes")) {
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
        return { isPending: false, error: null, refetch: vi.fn(), data: { layers: [] } };
      }
      if (path.includes("/api/v1/attendance/schedule/calendar")) {
        return { isPending: false, error: null, refetch: vi.fn(), data: { month: "2026-11", days: [] } };
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
      return { isPending: false, error: null, refetch: vi.fn(), data: [] };
    },
  };
});

beforeAll(() => loadCatalog("ko"));
beforeEach(() => {
  state.search = { date: "2026-11-16", month: "2026-11", person: "e1" };
  state.experience = "console";
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
