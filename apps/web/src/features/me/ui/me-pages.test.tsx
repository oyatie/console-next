// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import { ApiError } from "../../../reference/authz/api";
import { MeAttendancePage } from "./me-attendance-page";
import { MeDeskPage } from "./me-desk-page";

const state = vi.hoisted(() => ({
  search: {} as { month?: string; view?: "overview" | "attendance" | "requests" | "documents" },
  week52Status: "ok" as "ok" | "not_available",
  schedule403: false,
  records403: false,
  canClock: true,
  employeeLinkStatus: "LINKED" as "LINKED" | "UNLINKED",
}));

vi.mock("@tanstack/react-router", () => ({
  getRouteApi: () => ({ useSearch: () => state.search, useNavigate: () => vi.fn() }),
  Link: ({ children, to }: { children: ReactNode; to: string }) => <span data-link={to}>{children}</span>,
}));

vi.mock("../../../experience/dom", () => ({
  useActiveExperienceId: () => "console",
}));

vi.mock("@tanstack/react-query", async original => {
  const actual = await original<typeof import("@tanstack/react-query")>();
  return {
    ...actual,
    useQuery: (opts: Record<string, unknown>) => {
      const first = Object.values(opts).find(Array.isArray);
      const path = String(first?.[0] ?? "");
      if (opts.enabled === false) return { isPending: false, error: null, data: undefined, refetch: vi.fn() };
      if (path.includes("/api/v1/attendance/me/schedule")) {
        if (state.schedule403) {
          return {
            isPending: false,
            error: new ApiError(403, "employee_not_placed", "Unplaced"),
            data: undefined,
            refetch: vi.fn(),
          };
        }
        return {
          isPending: false,
          error: null,
          data: {
            month: "2026-11",
            work_days: 20,
            days: [
              {
                date: "2026-11-16",
                kind: "WORK",
                shift: { start: 540, end: 1080 },
                holiday_name: null,
              },
            ],
          },
          refetch: vi.fn(),
        };
      }
      if (path.includes("/api/v1/attendance/me/week52")) {
        return {
          isPending: false,
          error: null,
          data:
            state.week52Status === "not_available"
              ? { status: "not_available", week_start: "2026-11-16", reason: "no_schedule" }
              : {
                  status: "available",
                  week_start: "2026-11-16",
                  projection: {
                    current_hours: 34,
                    projected_hours: 40,
                    limit_hours: 52,
                    tone: "OK",
                  },
                },
          refetch: vi.fn(),
        };
      }
      if (path.includes("/api/v1/attendance/me/exceptions")) {
        return {
          isPending: false,
          error: null,
          data: { items: [], next_cursor: null },
          refetch: vi.fn(),
        };
      }
      if (path.includes("/api/v1/hr/attendance-records/me")) {
        if (state.records403) {
          return {
            isPending: false,
            error: new ApiError(403, "attendance.refuse.missing_grant", "Refused"),
            data: undefined,
            refetch: vi.fn(),
          };
        }
        return {
          isPending: false,
          error: null,
          data: {
            items: [
              {
                id: "rec-1",
                employee_id: "e1",
                employee_display_name: "Hajun Yun",
                kind: "CLOCK_IN",
                occurred_at: "2026-11-16T00:00:00Z",
                work_date: "2026-11-16",
                state_after: "CLOCKED_IN",
                note: null,
                duplicate: false,
              },
            ],
            next_cursor: null,
          },
          refetch: vi.fn(),
        };
      }
      if (path.includes("/api/v1/access/me")) {
        return {
          isPending: false,
          error: null,
          data: {
            is_ops: false,
            phase: "OPERATING",
            entries: state.canClock
              ? [
                  {
                    grant_id: "g-att",
                    role_id: "r1",
                    role_name_ko: "Self",
                    domain: "attendance",
                    level: "edit",
                    enforcement: "ENFORCED",
                    valid_from: "2026-01-01T00:00:00Z",
                    scope: { kind: "DEPARTMENT", node_id: "d1", include_descendants: false },
                    caveats: [],
                  },
                ]
              : [],
            decisions: {},
          },
          refetch: vi.fn(),
        };
      }
      if (path.includes("/api/v1/users/me")) {
        return {
          isPending: false,
          error: null,
          data: {
            id: "u1",
            display_name: "Hajun Yun",
            employee_id: state.employeeLinkStatus === "LINKED" ? "e1" : null,
            employee_name: "Hajun Yun",
            employee_company: "Saeon Group",
            employee_org_unit: "Prod Team 1",
            employee_link_status: state.employeeLinkStatus,
            tenant: { name: "Saeon Group", phase: "OPERATING" },
          },
          refetch: vi.fn(),
        };
      }
      if (path.includes("/api/v1/me/profile")) {
        return { isPending: false, error: null, data: { employee_id: "e1", org_unit: "Prod Team 1" }, refetch: vi.fn() };
      }
      if (path.includes("/api/v2/me/leave")) {
        return {
          isPending: false,
          error: null,
          data: { balance: { remaining_units: 11 }, requests: { items: [] } },
          refetch: vi.fn(),
        };
      }
      if (path.includes("/api/v1/change-requests")) {
        return { isPending: false, error: null, data: { items: [] }, refetch: vi.fn() };
      }
      if (path.includes("/api/v1/me/inbox-docs")) {
        return { isPending: false, error: null, data: { items: [] }, refetch: vi.fn() };
      }
      return { isPending: false, error: null, data: undefined, refetch: vi.fn() };
    },
  };
});

beforeAll(() => loadCatalog("ko"));
beforeEach(() => {
  state.search = {};
  state.week52Status = "ok";
  state.schedule403 = false;
  state.records403 = false;
  state.canClock = true;
  state.employeeLinkStatus = "LINKED";
});

function render(node: ReactNode) {
  const qc = new QueryClient();
  return renderToStaticMarkup(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

test("me attendance renders week52 hours, schedule, and gated clock action in console mode", () => {
  const html = render(<MeAttendancePage />);
  expect(html).toContain(t("me.attendance.title"));
  expect(html).toContain(t("me.attendance.records.clockOut"));
  expect(html).toContain("09:00–18:00");
});

test("me attendance renders honest not-provided label when week52 is not available", () => {
  state.week52Status = "not_available";
  const html = render(<MeAttendancePage />);
  expect(html).toContain(t("me.attendance.week52.notAvailable"));
});

test("me attendance isolates schedule 403 inline without hiding clock records or week52", () => {
  state.schedule403 = true;
  const html = render(<MeAttendancePage />);
  expect(html).toContain(t("me.attendance.schedule.refusedTitle"));
  expect(html).toContain(t("me.attendance.records.title"));
  expect(html).toContain(t("me.attendance.week52.hours", { hours: 34 }));
});

test("me attendance hides clock button when attendance write grant is missing", () => {
  state.canClock = false;
  const html = render(<MeAttendancePage />);
  expect(html).not.toContain(`>${t("me.attendance.records.clockOut")}<`);
  expect(html).not.toContain(`>${t("me.attendance.records.clockIn")}<`);
});

test("me desk surfaces honest unlinked notice and secondary query 403 refusals", () => {
  state.employeeLinkStatus = "UNLINKED";
  const unlinkedHtml = render(<MeDeskPage />);
  expect(unlinkedHtml).toContain(t("me.desk.title"));
  expect(unlinkedHtml).toContain(t("me.desk.profile.unlinked"));

  state.employeeLinkStatus = "LINKED";
  state.records403 = true;
  const refusedHtml = render(<MeDeskPage />);
  expect(refusedHtml).toContain("attendance.refuse.missing_grant");
  expect(refusedHtml).not.toContain(t("me.desk.requests.empty"));
  expect(refusedHtml).not.toContain(t("me.desk.payslips.empty"));
});
