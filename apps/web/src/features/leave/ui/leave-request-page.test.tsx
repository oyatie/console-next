// SPDX-License-Identifier: LicenseRef-Proprietary
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import { fmtDateShortWeekday } from "@console/i18n/format";
import { readIdentity } from "../../../lib/query";
import { ApiError, leaveSubmitError } from "../api";
import { LeaveRequestPage } from "./leave-request-page";

type MockLeaveState = {
  data?: unknown;
  error?: unknown;
  scheduleErrorMonths?: readonly string[];
  teamOverlap?: { data?: unknown; error?: unknown };
  approvalPreview?: { data?: unknown; error?: unknown };
  linkStatus?: "LINKED" | "UNLINKED";
  /** users/me not yet answered, or failed. */
  me?: "pending" | "error";
  /** Leave the cache still holds from before, which a disabled query keeps answering with. */
  cachedLeave?: boolean;
  enabled?: Record<string, boolean | undefined>;
};

const mockState = vi.hoisted((): MockLeaveState => ({ enabled: {} }));

const ok = (data: unknown) => ({ data, isPending: false, isFetching: false, isError: false, isSuccess: true, error: null, dataUpdatedAt: 1 });
const failed = (error: unknown) => ({ data: undefined, isPending: false, isFetching: false, isError: true, isSuccess: false, error, dataUpdatedAt: 0 });
const pending = { data: undefined, isPending: true, isFetching: false, isError: false, isSuccess: false, error: null, dataUpdatedAt: 0 };
const outage = () => new ApiError(503, "service_unavailable", "");

function resolveMockQuery(options: Parameters<typeof readIdentity>[0] & { enabled?: boolean }) {
  const parsed = JSON.parse(readIdentity(options)) as [string, { query?: { month?: string } }?];
  const path = String(parsed[0]);
  mockState.enabled![path] = options.enabled;
  if (path === "/api/v1/users/me") {
    return mockState.me === "pending" ? pending : mockState.me === "error" ? failed(outage()) : ok({ employee_link_status: mockState.linkStatus });
  }
  if (options.enabled === false) return path === "/api/v2/me/leave" && mockState.cachedLeave ? ok(mockState.data) : pending;
  if (path === "/api/v2/me/leave") return mockState.error ? failed(mockState.error) : ok(mockState.data);
  if (path === "/api/v1/attendance/me/schedule") {
    const month = parsed[1]?.query?.month ?? "2026-11";
    return mockState.scheduleErrorMonths?.includes(month) ? failed(outage()) : ok({ month, days: [] });
  }
  const side = path === "/api/v2/me/leave/team-overlap" ? mockState.teamOverlap : path === "/api/v2/me/leave/approval-preview" ? mockState.approvalPreview : undefined;
  if (side?.error) return failed(side.error);
  if (side?.data) return ok(side.data);
  return pending;
}

const BALANCE = {
  employee_id: "00000000-0000-4000-8300-000000001287",
  name: "Yoon Hajun",
  accrued_units: "15.000000",
  used_units: "5.500000",
  remaining_units: "9.500000",
  filing_state: "ready",
  home_branch_id: "00000000-0000-4000-8200-000000000102",
};
const NO_REQUESTS = { items: [], next_cursor: null };

vi.mock("../../../experience/dom", () => ({ useActiveExperienceId: () => "console" }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@tanstack/react-query", async (original) => ({
  ...(await original<typeof import("@tanstack/react-query")>()),
  useQuery: (options: Parameters<typeof readIdentity>[0] & { enabled?: boolean }) => resolveMockQuery(options),
  useQueries: ({ queries }: { queries: Array<Parameters<typeof readIdentity>[0] & { enabled?: boolean }> }) =>
    queries.map((q) => resolveMockQuery(q)),
}));

beforeAll(() => loadCatalog("ko"));
afterEach(() => {
  vi.useRealTimers();
});

function renderWithState(next: MockLeaveState) {
  Object.assign(mockState, { linkStatus: "LINKED", scheduleErrorMonths: [], ...next, enabled: {} });
  for (const key of ["data", "error", "teamOverlap", "approvalPreview", "me", "cachedLeave"] as const) if (!(key in next)) delete mockState[key];
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false } } });
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <LeaveRequestPage />
      </QueryClientProvider>,
    );
  } finally {
    client.clear();
  }
}

test("LeaveRequestPage renders populated balance, 30-cell Meter, and 3 leave types without condolence or reason", () => {
  const html = renderWithState({
    data: { balance: BALANCE, requests: NO_REQUESTS },
  });

  expect(html).toContain('data-pattern="form"');
  expect(html).toContain('role="meter"');
  expect(html.match(/data-state="used"/g)).toHaveLength(11);
  expect(html.match(/data-state="pending"/g)).toHaveLength(2);
  expect(html.match(/data-state="rest"/g)).toHaveLength(17);
  expect(html).toContain(t("leave.type.annual"));
  expect(html).toContain(t("leave.type.halfAm"));
  expect(html).toContain(t("leave.type.halfPm"));
  expect(html).not.toContain("<textarea");
});

test("LeaveRequestPage blocks filing when home_branch_required and preserves error states on 403/503", () => {
  const closedHtml = renderWithState({
    data: { balance: { ...BALANCE, filing_state: "home_branch_required", home_branch_id: null }, requests: NO_REQUESTS },
  });
  expect(closedHtml).toContain(t("leave.filing.homeBranchRequired.title"));
  expect(closedHtml).toContain("disabled");

  const refusedHtml = renderWithState({
    error: new ApiError(403, "forbidden", ""),
  });
  expect(refusedHtml).toContain(t("common.denied.title.plain"));
  expect(refusedHtml).not.toContain('role="meter"');

  const failedHtml = renderWithState({
    error: new ApiError(503, "service_unavailable", "", [], "op-503"),
  });
  expect(failedHtml).toContain(t("common.loadFailed.title"));
  expect(failedHtml).toContain("op-503");
});

test("LeaveRequestPage formats null balance units as unset in Meter valuetext, renders 2-line history rows, and excludes weekends when schedule fails", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-21T09:00:00+09:00"));

  const nullBalanceHtml = renderWithState({
    data: {
      balance: { ...BALANCE, accrued_units: null, used_units: null, remaining_units: null },
      requests: {
        items: [
          {
            id: "00000000-0000-4000-8800-000000000101",
            branch_id: "00000000-0000-4000-8200-000000000102",
            requester_user_id: "00000000-0000-4000-8000-000000000587",
            subject_employee_id: "00000000-0000-4000-8300-000000001287",
            leave_type: "half_day",
            days: 0.5,
            charge_units: "0.500000",
            charge_state: "resolved",
            charge_review_reasons: [],
            request_version: 1,
            charge_version: 1,
            partial_day_period: "am",
            start_date: "2026-11-06",
            end_date: "2026-11-06",
            status: "approved",
            decided_by: "00000000-0000-4000-8000-000000000010",
            decided_at: "2026-11-05T14:20:00+09:00",
            created_at: "2026-11-04T09:15:00+09:00",
          },
        ],
        next_cursor: null,
      },
    },
    scheduleErrorMonths: ["2026-11"],
  });

  const unset = t("leave.balance.unset");
  expect(nullBalanceHtml).toContain(
    `aria-valuetext="${t("leave.meter.valueText", { accrued: unset, used: unset, pending: "0", after: unset })}"`,
  );
  expect(nullBalanceHtml).toContain(`${t("leave.type.halfAm")} · ${t("leave.balance.days", { days: "0.5" })}`);
  expect(nullBalanceHtml).toContain(fmtDateShortWeekday("2026-11-06"));
  expect(nullBalanceHtml).toContain(t("leave.status.approved"));
});

test("LeaveRequestPage renders team overlap, localized approval preview without raw English labels, and maps 409 codes", () => {
  const html = renderWithState({
    data: { balance: { ...BALANCE, org_unit: "Prod Team 1" }, requests: NO_REQUESTS },
    teamOverlap: {
      data: {
        org_unit: "Prod Team 1",
        active_count: 12,
        out_count: 1,
        members_out: [{ employee_id: "e2", name: "Cho Gyeongsu" }],
      },
    },
    approvalPreview: {
      data: {
        filing_state: "ready",
        home_branch_id: "00000000-0000-4000-8200-000000000102",
        branch_name: "Pyeongtaek",
        org_unit: "Prod Team 1",
        steps: [
          { order: 1, step_kind: "unit_lead", role_label: "TEAM_LEAD", approver_name: "Song Jaewon", approver_position: "Lead" },
          { order: 2, step_kind: "branch_hr", role_label: "Pyeongtaek Approver", approver_name: null, approver_position: null },
        ],
      },
    },
  });

  expect(html).toContain(t("leave.teamOverlap.label"));
  expect(html).toContain("Cho Gyeongsu");
  expect(html).toContain(t("leave.teamOverlap.count", { unit: "Prod Team 1", active: 12, out: 1 }));
  expect(html).toContain(t("leave.approval.label"));
  expect(html).toContain("Song Jaewon Lead");
  expect(html).toContain(t("leave.approval.branchHr"));
  expect(html).not.toContain("TEAM_LEAD");
  expect(html).not.toContain("Approver");

  const degradedHtml = renderWithState({
    data: { balance: BALANCE, requests: NO_REQUESTS },
    teamOverlap: { error: new ApiError(403, "forbidden", "") },
    approvalPreview: { error: new ApiError(503, "service_unavailable", "") },
  });
  expect(degradedHtml).toContain(t("leave.teamOverlap.unavailable"));
  expect(degradedHtml).toContain(t("leave.approval.unavailable"));
  expect(degradedHtml).toContain(t("leave.submit"));

  expect(leaveSubmitError("leave_overlapping_request")).toBe(t("common.failed.code.leave_overlapping_request"));
  expect(leaveSubmitError("leave_create.overlapping_request")).toBe(t("common.failed.code.leave_overlapping_request"));
  expect(leaveSubmitError("leave_period_closed")).toBe(t("common.failed.code.leave_period_closed"));
  expect(leaveSubmitError("leave_create.period_closed")).toBe(t("common.failed.code.leave_period_closed"));
});

test("an account with no employee record is told why, and sends no leave read the server would refuse", () => {
  const html = renderWithState({ linkStatus: "UNLINKED" });
  expect(html).toContain(t("account.status.unlinked"));
  expect(html).toContain(t("me.desk.profile.unlinked"));
  expect(html).not.toContain('role="meter"');
  expect(mockState.enabled!["/api/v2/me/leave"]).toBe(false);
  expect(mockState.enabled!["/api/v1/attendance/me/schedule"]).toBe(false);
});

test("until users/me answers, the page shows that read, not a leave read it never sent", () => {
  const waiting = renderWithState({ me: "pending" });
  expect(waiting).toContain('aria-busy="true"');
  expect(waiting).not.toContain(t("account.status.unlinked"));
  expect(mockState.enabled!["/api/v2/me/leave"]).toBe(false);

  // A failed users/me is the page's failed read. Leave cached from before is not shown or filed against.
  const failedMe = renderWithState({ me: "error", cachedLeave: true, data: { balance: BALANCE, requests: NO_REQUESTS } });
  expect(failedMe).toContain(t("common.loadFailed.title"));
  expect(failedMe).toContain(t("common.retry"));
  expect(failedMe).not.toContain('role="meter"');
  for (const path of ["/api/v2/me/leave", "/api/v1/attendance/me/schedule", "/api/v2/me/leave/team-overlap", "/api/v2/me/leave/approval-preview"]) {
    expect(mockState.enabled![path], path).toBe(false);
  }
});
