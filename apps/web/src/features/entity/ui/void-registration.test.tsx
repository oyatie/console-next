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

const endRead = vi.hoisted(() => ({ current: undefined as unknown }));
vi.mock("@tanstack/react-query", async (original) => ({
  ...(await original<typeof import("@tanstack/react-query")>()),
  useQuery: () => ({ data: endRead.current, isPending: false, isError: false }),
}));
vi.mock("../../../ui/dialog", () => ({
  Dialog: ({ open, title, children }: { open: boolean; title: string; children: ReactNode }) =>
    open ? <div role="dialog" aria-label={title}><h2>{title}</h2>{children}</div> : null,
}));

beforeAll(() => loadCatalog("ko"));
afterEach(() => { endRead.current = undefined; });

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

test("CertCard offers the ⋯ menu with 삭제 in setup and renders cascade preview + reason choices from end-options read", async () => {
  const e = entity();
  const r = reg();
  endRead.current = {
    id: e.id,
    phase: "SETUP",
    delete: { allowed: true, refusal: null },
    close: { allowed: false, refusal: "record_never_used" },
    can_manage: true,
    open_exit_cases: 0,
  };
  const cardHtml = await renderWithRouter(() => <CertCard e={e} r={r} act={noopAct} operating={false} />);
  expect(cardHtml).toContain('aria-label="사업자등록증 더보기"');

  const dialogHtml = await renderWithRouter(() => <VoidRegistration e={e} r={r} onClose={() => undefined} />);
  expect(dialogHtml).toContain("사업자등록증 삭제");
  expect(dialogHtml).toContain("000-81-00028");
  expect(dialogHtml).toContain("개정 이력 2건");
  for (const label of ["중복 등록", "시험 입력", "다른 회사의 등록증"]) {
    expect(dialogHtml).toContain(label);
  }
  expect(dialogHtml).toContain(t("entity.void.reasonNeeded"));
  expect(dialogHtml).toContain('aria-disabled="true"');
});

test("VoidRegistration warns when workplaces use the certificate and renders record_in_use and forbidden refusals", async () => {
  const r = reg({ holder_workplace_id: "wp-1" });
  const e = entity({
    registrations: [r],
    workplaces: [{ id: "wp-1", registration_id: "reg-1", is_head_office: true, current: { name: "본점", status: "CONTINUING" } } as unknown as LegalEntity["workplaces"][number]],
  });
  endRead.current = {
    id: e.id,
    phase: "SETUP",
    delete: { allowed: false, refusal: "record_in_use" },
    close: { allowed: true, refusal: null },
    can_manage: true,
    open_exit_cases: 0,
  };

  const inUseHtml = await renderWithRouter(() => <VoidRegistration e={e} r={r} onClose={() => undefined} error={new ApiError(409, "record_in_use", "in use")} />);
  expect(inUseHtml).toContain("본점");
  expect(inUseHtml).toContain('role="alert"');
  expect(inUseHtml).toContain(t("entity.refused.record_in_use"));

  endRead.current = {
    id: e.id,
    phase: "SETUP",
    delete: { allowed: true, refusal: null },
    close: { allowed: false, refusal: "record_never_used" },
    can_manage: false,
    open_exit_cases: 0,
  };
  const forbiddenHtml = await renderWithRouter(() => <VoidRegistration e={e} r={r} onClose={() => undefined} error={new ApiError(403, "forbidden", "forbidden")} />);
  expect(forbiddenHtml).toContain(t("crud.noPermission"));
  expect(forbiddenHtml).toContain(t("crud.refused.forbidden"));
});
