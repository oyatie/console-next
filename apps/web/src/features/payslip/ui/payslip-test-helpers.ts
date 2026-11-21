// SPDX-License-Identifier: LicenseRef-Proprietary
import { readIdentity } from "../../../lib/query";

export type MockPayslipState = {
  experience: "console" | "baseline";
  search: { doc?: string; month?: string };
  listData?: unknown;
  listError?: unknown;
  detailData?: unknown;
  detailError?: unknown;
  detailPending?: boolean;
  detailIsPlaceholderData?: boolean;
};

export function resolveMockPayslipQuery(
  options: Parameters<typeof readIdentity>[0] & { enabled?: boolean },
  state: MockPayslipState,
) {
  const parsed = JSON.parse(readIdentity(options)) as [string];
  const path = String(parsed[0]);
  if (options.enabled === false) {
    return {
      data: undefined,
      isPending: true,
      isFetching: false,
      isError: false,
      isSuccess: false,
      error: null,
      dataUpdatedAt: 0,
      refetch: () => Promise.resolve(),
    };
  }
  if (path === "/api/v1/me/inbox-docs") {
    if (state.listError) {
      return {
        data: undefined,
        isPending: false,
        isFetching: false,
        isError: true,
        isSuccess: false,
        error: state.listError,
        dataUpdatedAt: 0,
        refetch: () => Promise.resolve(),
      };
    }
    return {
      data: state.listData,
      isPending: false,
      isFetching: false,
      isError: false,
      isSuccess: true,
      error: null,
      dataUpdatedAt: 1,
      refetch: () => Promise.resolve(),
    };
  }
  if (path === "/api/v1/me/inbox-docs/{id}") {
    if (state.detailPending) {
      return {
        data: state.detailData,
        isPending: !state.detailData,
        isFetching: true,
        isError: false,
        isSuccess: false,
        isPlaceholderData: Boolean(state.detailIsPlaceholderData),
        error: null,
        dataUpdatedAt: 0,
        refetch: () => Promise.resolve(),
      };
    }
    if (state.detailError) {
      return {
        data: state.detailData,
        isPending: false,
        isFetching: false,
        isError: true,
        isSuccess: false,
        error: state.detailError,
        dataUpdatedAt: state.detailData ? 1 : 0,
        refetch: () => Promise.resolve(),
      };
    }
    return {
      data: state.detailData,
      isPending: false,
      isFetching: false,
      isError: false,
      isSuccess: true,
      isPlaceholderData: Boolean(state.detailIsPlaceholderData),
      error: null,
      dataUpdatedAt: 1,
      refetch: () => Promise.resolve(),
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
    refetch: () => Promise.resolve(),
  };
}

export const samplePayslipDoc = {
  id: "00000000-0000-4000-8950-000000002010",
  recipient_user_id: "00000000-0000-4000-8000-000000000587",
  kind: "payslip",
  title: "Statement 2026-10",
  locked: false,
  created_at: "2026-11-25T00:00:00Z",
  payslip_meta: {
    attribution_month: "2026-10",
    period_start: "2026-10-01",
    period_end: "2026-10-31",
    pay_date: "2026-11-25",
    gross_won: 3_567_000,
    net_won: 3_141_755,
  },
};

export const samplePayslipDetail = {
  ...samplePayslipDoc,
  payload: {
    attribution_month: "2026-10",
    period_start: "2026-10-01",
    period_end: "2026-10-31",
    pay_date: "2026-11-25",
    work_days: 18,
    paid_holiday_days: 4,
    overtime_hours: 12,
    leave_used: 0,
    base_pay_won: 3_100_000,
    overtime_pay_won: 267_000,
    meal_allowance_won: 200_000,
    gross_won: 3_567_000,
    deductions: [{ code: "NATIONAL_PENSION", label_ko: "Pension", amount_won: 151_515 }],
    total_deductions_won: 425_245,
    net_won: 3_141_755,
  },
};
