// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import type { BusinessRegistration, LegalEntity } from "@console/api/pending";
import { loadCatalog, t } from "@console/i18n";
import { ApiError } from "../api";
import type { Act } from "./record-revise-sheet";
import { CertCard } from "./record-cert-card";
import { VoidRegistration } from "./void-registration";

const endRead = vi.hoisted(() => ({ current: undefined as unknown, error: null as unknown }));
vi.mock("@tanstack/react-query", async (original) => ({
  ...(await original<typeof import("@tanstack/react-query")>()),
  useQuery: () => ({ data: endRead.current, error: endRead.error, isFetching: !endRead.current && !endRead.error, isPending: !endRead.current && !endRead.error, isError: !!endRead.error }),
}));
vi.mock("../../../ui/dialog", () => ({
  Dialog: ({ open, title, children }: { open: boolean; title: string; children: ReactNode }) =>
    open ? <div role="dialog" aria-label={title}><h2>{title}</h2>{children}</div> : null,
}));

beforeAll(() => loadCatalog("ko"));
afterEach(() => { endRead.current = undefined; endRead.error = null; });

const reg = (over: Partial<BusinessRegistration> = {}): BusinessRegistration => ({
  id: "reg-1",
  holder_workplace_id: null,
  brn: { value: "0008100028", display: "000-81-00028" },
  verification_tier: "UNVERIFIED",
  closed_on: null,
  current: {
    version: 2,
    effective_from: "2026-01-01",
    trade_name: "주식회사 누리",
    opened_on: "2026-01-01",
    business_address: { source: "MANUAL_UNVERIFIED", road_addr_part1: "서울 테헤란로 152", si_nm: "서울특별시" },
    tax_type: "01",
    status: "CONTINUING",
    status_since: null,
    status_until: null,
    business_types: [{ is_main: true, sector_as_printed: "서비스", item_as_printed: "소프트웨어", ksic: null }],
    issue_reason_kind: "NEW",
    cert_issued_on: "2026-01-02",
    tax_office_code: "101",
    tax_office_label: "삼성세무서",
    liquor_license_no: null,
    unit_taxation: false,
    e_invoice_email: null,
    classification_reason: null,
  },
  ...over,
} as unknown as BusinessRegistration);

const entity = (over: Partial<LegalEntity> = {}): LegalEntity => ({
  id: "ent-1",
  biz_kind: "CORPORATION",
  can_manage: true,
  read_only: false,
  closed_on: null,
  current: { name: "주식회사 누리", representatives: ["김예시"], effective_from: "2026-01-01" },
  registrations: [reg()],
  workplaces: [],
  scheduled: [],
  identity_problems: [],
  name_reviews: [],
  ...over,
} as unknown as LegalEntity);

const noopAct: Act = {
  field: () => undefined,
  identifier: () => undefined,
  reissue: () => undefined,
  close: () => undefined,
  remove: () => undefined,
};

async function renderWithRouter(node: () => ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const root = createRootRoute({ component: node });
  const requests = createRoute({ getParentRoute: () => root, path: "/requests/$id" });
  const router = createRouter({ routeTree: root.addChildren([requests]), history: createMemoryHistory({ initialEntries: ["/"] }) });
  await router.load();
  return renderToStaticMarkup(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>);
}

const options = (over = {}) => ({
  id: "reg-1", phase: "SETUP", delete: { allowed: true, refusal: null },
  can_manage: true, revisions: 7, linked_workplaces: [], ...over,
});

test("CertCard offers the certificate menu; the dialog reads its cascade count from registration end-options", async () => {
  endRead.current = options();
  const card = await renderWithRouter(() => <CertCard e={entity()} r={reg()} act={noopAct} operating={false} />);
  expect(card).toContain('aria-label="사업자등록증 더보기"');
  const html = await renderWithRouter(() => <VoidRegistration r={reg()} onClose={() => undefined} />);
  expect(html).toContain("000-81-00028");
  expect(html).toContain("개정 이력 7건");
  for (const code of ["DUPLICATE", "TEST_ENTRY", "WRONG_DOCUMENT"] as const) expect(html).toContain(t(`entity.void.reason.${code}`));
  expect(html).toContain(t("entity.void.reasonNeeded"));
  expect(html).toContain('aria-disabled="true"');
});

test.each([
  ["missing preview", undefined, "entity.regVoid.previewLoading"],
  ["linked workplace", options({ linked_workplaces: [{ id: "wp-1", name: "서버에서 읽은 본점" }] }), "entity.refused.record_in_use"],
  ["refusal", options({ delete: { allowed: false, refusal: "record_in_use" } }), "entity.refused.record_in_use"],
  ["no grant", options({ can_manage: false }), "crud.noPermission"],
  ["operating", options({ phase: "OPERATING" }), "entity.regVoid.operatingWhy"],
] as const)("confirmation is disabled for %s", async (_name, preview, message) => {
  endRead.current = preview;
  const html = await renderWithRouter(() => <VoidRegistration r={reg()} onClose={() => undefined} />);
  expect(html).toContain(t(message));
  expect(html).toContain('aria-disabled="true"');
  if (_name === "linked workplace") expect(html).toContain("서버에서 읽은 본점");
});

test("a failed preview blocks even cached allowed data and offers a reread", async () => {
  endRead.current = options();
  endRead.error = new ApiError(503, "unavailable", "unavailable");
  const html = await renderWithRouter(() => <VoidRegistration r={reg()} onClose={() => undefined} />);
  expect(html).toContain(t("entity.regVoid.previewFailed"));
  expect(html).toContain(t("entity.regVoid.previewRetry"));
  expect(html).toContain('aria-disabled="true"');
});
