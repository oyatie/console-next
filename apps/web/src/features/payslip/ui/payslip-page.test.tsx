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
import {
  resolveMockPayslipQuery,
  samplePayslipDetail as sampleDetail,
  samplePayslipDoc as sampleDoc,
  type MockPayslipState,
} from "./payslip-test-helpers";

const mockState = vi.hoisted((): MockPayslipState => ({
  experience: "console",
  search: {},
  listData: { items: [], next_cursor: null },
}));

vi.mock("../../../experience/dom", () => ({ useActiveExperienceId: () => mockState.experience }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => children,
  useNavigate: () => () => Promise.resolve(),
  useSearch: () => mockState.search,
}));
vi.mock("@tanstack/react-query", async original => ({
  ...(await original<typeof import("@tanstack/react-query")>()),
  useQuery: (options: Parameters<typeof readIdentity>[0] & { enabled?: boolean }) =>
    resolveMockPayslipQuery(options, mockState),
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
    detailPending: false,
    detailIsPlaceholderData: false,
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

test("PayslipPage rejects mismatched or placeholder detail payloads and PayslipBaseline renders detail loading/403/503 states", () => {
  const septemberDoc = {
    ...sampleDoc,
    id: "00000000-0000-4000-8950-000000002009",
    title: "Statement 2026-09",
    payslip_meta: {
      ...sampleDoc.payslip_meta,
      attribution_month: "2026-09",
      pay_date: "2026-10-23",
      net_won: 2_908_474,
    },
  };

  const placeholderGuardHtml = renderPage({
    search: { doc: septemberDoc.id, month: "2026-09" },
    listData: { items: [sampleDoc, septemberDoc], next_cursor: null },
    detailData: sampleDetail,
    detailIsPlaceholderData: true,
  });
  expect(placeholderGuardHtml).toContain("10-23");
  expect(placeholderGuardHtml).not.toContain("3,141,755");
  expect(placeholderGuardHtml).not.toContain("11-25");

  const mismatchedIdHtml = renderPage({
    search: { doc: septemberDoc.id, month: "2026-09" },
    listData: { items: [sampleDoc, septemberDoc], next_cursor: null },
    detailData: sampleDetail,
  });
  expect(mismatchedIdHtml).toContain("10-23");
  expect(mismatchedIdHtml).not.toContain("3,141,755");
  expect(mismatchedIdHtml).toContain(t("payslip.detail.unavailable"));

  const baselineLoadingHtml = renderPage({
    experience: "baseline",
    listData: { items: [sampleDoc], next_cursor: null },
    detailPending: true,
  });
  expect(baselineLoadingHtml).toContain('aria-busy="true"');
  expect(baselineLoadingHtml).toContain('data-bone="short"');
  expect(baselineLoadingHtml).toContain('data-bone="title"');
  expect(baselineLoadingHtml).not.toContain('data-read-layout="record"');
  expect(baselineLoadingHtml).not.toContain(t("payslip.detail.unavailable"));

  const baselineDeniedHtml = renderPage({
    experience: "baseline",
    listData: { items: [sampleDoc], next_cursor: null },
    detailError: new ApiError(403, "forbidden", ""),
  });
  expect(baselineDeniedHtml).toContain(t("common.denied.panel"));
  expect(baselineDeniedHtml).not.toContain('data-read-layout="record"');
  expect(baselineDeniedHtml).toMatch(/<section[^>]*class="[^"]*card[^"]*"[^>]*>[\s\S]*common\.denied|class="[^"]*card[^"]*"[\s\S]*?<h2[^>]*>.*<\/h2>/);
  expect(baselineDeniedHtml).not.toContain(t("payslip.detail.unavailable"));

  const baselineFailedHtml = renderPage({
    experience: "baseline",
    listData: { items: [sampleDoc], next_cursor: null },
    detailError: new ApiError(503, "service_unavailable", ""),
  });
  expect(baselineFailedHtml).toContain(t("common.loadFailed.title"));
  expect(baselineFailedHtml).toContain(t("common.retry"));
  expect(baselineFailedHtml).not.toContain('data-read-layout="record"');
  expect(baselineFailedHtml).not.toContain(t("payslip.detail.unavailable"));

  const baselineNotFoundHtml = renderPage({
    experience: "baseline",
    listData: { items: [sampleDoc], next_cursor: null },
    detailError: new ApiError(404, "not_found", ""),
  });
  expect(baselineNotFoundHtml).toContain(t("common.read.notFound.title"));
  expect(baselineNotFoundHtml).not.toContain('data-read-layout="record"');
  expect(baselineNotFoundHtml.match(/<section[^>]*class="[^"]*card[^"]*"/g)?.length).toBe(2);
});

test("PayslipPage Console detail loading and 503 states use compact hero layout without record ReadSkeleton", () => {
  const consoleLoadingHtml = renderPage({
    listData: { items: [sampleDoc], next_cursor: null },
    detailPending: true,
  });
  expect(consoleLoadingHtml).toContain('data-bone="short"');
  expect(consoleLoadingHtml).toContain('data-bone="title"');
  expect(consoleLoadingHtml).not.toContain('data-read-layout="record"');

  const consoleFailedHtml = renderPage({
    listData: { items: [sampleDoc], next_cursor: null },
    detailError: new ApiError(503, "service_unavailable", ""),
  });
  expect(consoleFailedHtml).toContain(t("common.loadFailed.title"));
  expect(consoleFailedHtml).toContain(t("common.retry"));
  expect(consoleFailedHtml).not.toContain('data-read-layout="record"');
});

test("PayslipPage preserves cached statement in stale 503 state while suppressing cached payload on 403/404 in Console and Baseline", () => {
  const savePdfButtonDisabled = (html: string) => {
    const buttonHtml = html
      .match(/<button\b[\s\S]*?<\/button>/g)
      ?.find(tag => tag.includes(t("payslip.action.savePdf")));
    expect(buttonHtml).toBeDefined();
    return /\bdisabled\b/.test(buttonHtml!);
  };

  // Stale 503 with cached detail data in Console
  const consoleStaleHtml = renderPage({
    experience: "console",
    listData: { items: [sampleDoc], next_cursor: null },
    detailData: sampleDetail,
    detailError: new ApiError(503, "service_unavailable", ""),
  });
  expect(consoleStaleHtml).toContain(t("common.read.stale"));
  expect(consoleStaleHtml).toContain("3,141,755");
  expect(consoleStaleHtml).toContain("3,567,000");
  expect(consoleStaleHtml).toContain("3,100,000");
  expect(consoleStaleHtml).toContain("425,245");
  expect(consoleStaleHtml).toContain("151,515");
  expect(consoleStaleHtml).not.toContain(t("payslip.detail.unavailable"));
  expect(savePdfButtonDisabled(consoleStaleHtml)).toBe(false);

  // Stale 503 with cached detail data in Baseline
  const baselineStaleHtml = renderPage({
    experience: "baseline",
    listData: { items: [sampleDoc], next_cursor: null },
    detailData: sampleDetail,
    detailError: new ApiError(503, "service_unavailable", ""),
  });
  expect(baselineStaleHtml).toContain(t("common.read.stale"));
  expect(baselineStaleHtml).toContain("3,141,755");
  expect(baselineStaleHtml).toContain("3,567,000");
  expect(baselineStaleHtml).toContain("3,100,000");
  expect(baselineStaleHtml).toContain("425,245");
  expect(baselineStaleHtml).toContain("151,515");
  expect(baselineStaleHtml).not.toContain(t("payslip.detail.unavailable"));
  expect(savePdfButtonDisabled(baselineStaleHtml)).toBe(false);
  const baselineCardCount = baselineStaleHtml.match(/<section[^>]*class="[^"]*card[^"]*"/g)?.length ?? 0;
  expect(baselineCardCount).toBeGreaterThanOrEqual(4);
  expect(baselineCardCount).toBeLessThanOrEqual(5);

  // 403 denied with prior cached data must suppress payload in Console and Baseline
  for (const experience of ["console", "baseline"] as const) {
    const deniedWithDataHtml = renderPage({
      experience,
      listData: { items: [sampleDoc], next_cursor: null },
      detailData: sampleDetail,
      detailError: new ApiError(403, "forbidden", ""),
    });
    expect(deniedWithDataHtml).toContain(t("common.denied.panel"));
    expect(deniedWithDataHtml).not.toContain("3,141,755");
    expect(deniedWithDataHtml).not.toContain("3,567,000");
    expect(deniedWithDataHtml).not.toContain("3,100,000");
    expect(savePdfButtonDisabled(deniedWithDataHtml)).toBe(true);
  }

  // 404 not-found with prior cached data must suppress payload in Console and Baseline
  for (const experience of ["console", "baseline"] as const) {
    const notFoundWithDataHtml = renderPage({
      experience,
      listData: { items: [sampleDoc], next_cursor: null },
      detailData: sampleDetail,
      detailError: new ApiError(404, "not_found", ""),
    });
    expect(notFoundWithDataHtml).toContain(t("common.read.notFound.title"));
    expect(notFoundWithDataHtml).not.toContain("3,141,755");
    expect(notFoundWithDataHtml).not.toContain("3,567,000");
    expect(notFoundWithDataHtml).not.toContain("3,100,000");
    expect(savePdfButtonDisabled(notFoundWithDataHtml)).toBe(true);
  }
});
