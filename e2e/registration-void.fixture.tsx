// SPDX-License-Identifier: LicenseRef-Proprietary
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import type { BusinessRegistration, LegalEntity } from "@console/api/pending";
import { configure } from "@console/api";
import { webPlatform } from "@console/api/web";
import { loadCatalog } from "@console/i18n";
import { get } from "../apps/web/src/lib/query";
import type { Act } from "../apps/web/src/features/entity/ui/record-revise-sheet";
import { CertCard } from "../apps/web/src/features/entity/ui/record-cert-card";
import { lockOf, RecordLockProvider } from "../apps/web/src/features/entity/ui/use-record-lock";
import "../apps/web/src/app.css";

export const fixtureUrl = import.meta.url;

if (typeof document !== "undefined") {
  configure(webPlatform);
  await loadCatalog("ko");

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

  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const params = new URLSearchParams(location.search);
  const previewKey = get("/api/v1/business-registrations/{registrationId}/end-options", { params: { path: { registrationId: "reg-1" } } }).queryKey;
  window.addEventListener("registration-preview-refresh", () => { void client.refetchQueries({ queryKey: previewKey }); });
  if (params.has("cached")) {
    client.setQueryData(previewKey, {
      id: "reg-1", phase: "SETUP", can_manage: true, delete: { allowed: true, refusal: null }, revisions: 99, linked_workplaces: [],
    });
  }
  const e = entity(params.has("locked") ? { can_manage: false } : {});
  const r = reg();
  if (params.has("closed")) r.current!.status = "CLOSED";
  const root = createRootRoute({ component: () => <RecordLockProvider value={lockOf(e)}><><CertCard e={e} r={r} act={noopAct} operating={params.has("operating")} />{params.has("multiple") && <CertCard e={e} r={reg({ id: "reg-2", brn: { value: "0008100071", display: "000-81-00071" } })} act={noopAct} operating={false} />}</></RecordLockProvider> });
  const requests = createRoute({ getParentRoute: () => root, path: "/requests/$id" });
  const entityRoute = createRoute({ getParentRoute: () => root, path: "/org/entities/$id" });
  const router = createRouter({ routeTree: root.addChildren([requests, entityRoute]), history: createMemoryHistory({ initialEntries: ["/"] }) });
  await router.load();
  createRoot(document.getElementById("root")!).render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>);
}
