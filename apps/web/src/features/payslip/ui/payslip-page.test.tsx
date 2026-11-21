// SPDX-License-Identifier: LicenseRef-Proprietary
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { beforeAll, expect, test, vi } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import { fmtMonth } from "@console/i18n/format";
import { readIdentity } from "../../../lib/query";
import { ApiError } from "../api";
import { PayslipPage } from "./payslip-page";

type MockPayslipState = {
  experience: "console" | "baseline";
  search: { doc?: string; month?: string };
  listData?: unknown;
  listError?: unknown;
  detailData?: unknown;
  detailError?: unknown;
};

const mockState = vi.hoisted((): MockPayslipState => ({
  experience: "console",
  search: {},
  listData: { items: [], next_cursor: null },
}));

function resolveMockQuery(options: Parameters<typeof readIdentity>[0] & { enabled?: boolean }) {
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
    if (mockState.listError) {
      return {
        data: undefined,
        isPending: false,
        isFetching: false,
        isError: true,
        isSuccess: false,
        error: mockState.listError,
        dataUpdatedAt: 0,
        refetch: () => Promise.resolve(),
      };
    }
    return {
      data: mockState.listData,
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
    if (mockState.detailError) {
      return {
        data: undefined,
        isPending: false,
        isFetching: false,
        isError: true,
        isSuccess: false,
        error: mockState.detailError,
        dataUpdatedAt: 0,
        refetch: () => Promise.resolve(),
      };
    }
    return {
      data: mockState.detailData,
      isPending: false,
      isFetching: false,
      isError: false,
      isSuccess: true,
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

vi.mock("../../../experience/dom", () => ({ useActiveExperienceId: () => mockState.experience }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => children,
  useNavigate: () => () => Promise.resolve(),
  useSearch: () => mockState.search,
}));
vi.mock("@tanstack/react-query", async original => ({
  ...(await original<typeof import("@tanstack/react-query")>()),
  useQuery: (options: Parameters<typeof readIdentity>[0] & { enabled?: boolean }) => resolveMockQuery(options),
}));

beforeAll(() => loadCatalog("ko"));

function renderPage(next: Partial<MockPayslipState>) {
  Object.assign(mockState, {
    experience: "console",
    search: {},
    listData: { items: [], next_cursor: null },
    listError: undefined,
    detailData: undefined,
    detailError: undefined,
    ...next,
  });
  const client = new QueryClient();
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <PayslipPage />
      </QueryClientProvider>,
    );
  } finally {
    client.clear();
  }
}

const sampleDoc = {
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

const sampleDetail = {
  ...sampleDoc,
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

test("PayslipPage renders Console PhoneStatement with earnings, deductions, work summary, and baseline fallback", () => {
  const consoleHtml = renderPage({ listData: { items: [sampleDoc], next_cursor: null }, detailData: sampleDetail });
  expect(consoleHtml).toContain('data-pattern="phone-statement"');
  expect(consoleHtml).toContain("3,141,755");
  expect(consoleHtml).toContain("3,567,000");
  expect(consoleHtml).toContain("425,245");
  expect(consoleHtml).toContain("3,100,000");
  expect(consoleHtml).toContain(t("payslip.action.savePdf"));
  expect(consoleHtml).toContain(t("payslip.action.past"));
  expect(consoleHtml).toContain("11-25");

  const baselineHtml = renderPage({
    experience: "baseline",
    listData: { items: [sampleDoc], next_cursor: null },
    detailData: sampleDetail,
  });
  expect(baselineHtml).not.toContain('data-pattern="phone-statement"');
  expect(baselineHtml).toContain('data-floorplan="P-02"');
  expect(baselineHtml).toContain("3,141,755");
});

test("PayslipPage renders empty, monthEmpty, 403 refusal, and 404 detail failure states cleanly", () => {
  const emptyHtml = renderPage({ listData: { items: [], next_cursor: null } });
  expect(emptyHtml).toContain(t("payslip.empty.title"));

  const monthEmptyHtml = renderPage({
    search: { month: "2026-07" },
    listData: { items: [sampleDoc], next_cursor: null },
  });
  expect(monthEmptyHtml).toContain(t("payslip.monthEmpty.title", { month: fmtMonth("2026-07") }));

  const deniedHtml = renderPage({ listError: new ApiError(403, "forbidden", "") });
  expect(deniedHtml).toContain(t("common.denied.title.plain"));

  const detailNotFoundHtml = renderPage({
    listData: { items: [sampleDoc], next_cursor: null },
    detailError: new ApiError(404, "not_found", ""),
  });
  expect(detailNotFoundHtml).toContain(t("common.read.notFound.title"));
  expect(detailNotFoundHtml).toContain(t("payslip.action.past"));
});
