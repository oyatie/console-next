// SPDX-License-Identifier: LicenseRef-Proprietary
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import { fmtDateShortWeekday } from "@console/i18n/format";
import { readIdentity } from "../../../lib/query";
import { ApiError } from "../api";
import { LeaveRequestPage } from "./leave-request-page";

type MockLeaveState = {
  data?: unknown;
  error?: unknown;
  scheduleErrorMonths?: readonly string[];
};

const mockState = vi.hoisted((): MockLeaveState => ({ data: undefined, error: undefined, scheduleErrorMonths: [] }));

function resolveMockQuery(options: Parameters<typeof readIdentity>[0] & { enabled?: boolean }) {
  const parsed = JSON.parse(readIdentity(options)) as [string, { query?: { month?: string } }?];
  const path = String(parsed[0]);
  if (options.enabled === false) {
    return { data: undefined, isPending: true, isFetching: false, isError: false, isSuccess: false, error: null, dataUpdatedAt: 0 };
  }
  if (path === "/api/v2/me/leave") {
    if (mockState.error) {
      return {
        data: undefined,
        isPending: false,
        isFetching: false,
        isError: true,
        isSuccess: false,
        error: mockState.error,
        dataUpdatedAt: 0,
      };
    }
    return {
      data: mockState.data,
      isPending: false,
      isFetching: false,
      isError: false,
      isSuccess: true,
      error: null,
      dataUpdatedAt: 1,
    };
  }
  if (path === "/api/v1/attendance/me/schedule") {
    const month = parsed[1]?.query?.month ?? "2026-11";
    if (mockState.scheduleErrorMonths?.includes(month)) {
      return {
        data: undefined,
        isPending: false,
        isFetching: false,
        isError: true,
        isSuccess: false,
        error: new ApiError(503, "service_unavailable", ""),
        dataUpdatedAt: 0,
      };
    }
    return {
      data: { month, days: [] },
      isPending: false,
      isFetching: false,
      isError: false,
      isSuccess: true,
      error: null,
      dataUpdatedAt: 1,
    };
  }
  return {
    data: undefined,
    isPending: true,
    isFetching: false,
    isError: false,
    isSuccess: false,
    error: null,
    dataUpdatedAt: 0,
  };
}

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
  mockState.data = next.data;
  mockState.error = next.error;
  mockState.scheduleErrorMonths = next.scheduleErrorMonths ?? [];
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
    data: {
      balance: {
        employee_id: "00000000-0000-4000-8300-000000001287",
        name: "Yoon Hajun",
        accrued_units: "15.000000",
        used_units: "5.500000",
        remaining_units: "9.500000",
        filing_state: "ready",
        home_branch_id: "00000000-0000-4000-8200-000000000102",
      },
      requests: { items: [], next_cursor: null },
    },
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
    data: {
      balance: {
        employee_id: "00000000-0000-4000-8300-000000001287",
        name: "Yoon Hajun",
        accrued_units: "15.000000",
        used_units: "5.500000",
        remaining_units: "9.500000",
        filing_state: "home_branch_required",
        home_branch_id: null,
      },
      requests: { items: [], next_cursor: null },
    },
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
      balance: {
        employee_id: "00000000-0000-4000-8300-000000001287",
        name: "Yoon Hajun",
        accrued_units: null,
        used_units: null,
        remaining_units: null,
        filing_state: "ready",
        home_branch_id: "00000000-0000-4000-8200-000000000102",
      },
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
