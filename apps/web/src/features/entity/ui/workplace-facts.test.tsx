// SPDX-License-Identifier: LicenseRef-Proprietary
import { beforeAll, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { LegalEntity, Workplace } from "@console/api/pending";
import { loadCatalog } from "@console/i18n";
import { WorkplaceFacts } from "./workplace-facts";

vi.mock("@tanstack/react-router", async (original) => ({ ...await original<object>(), useNavigate: () => () => {} }));
beforeAll(() => loadCatalog("ko"));

for (const abstract of [false, true]) {
  test(`finished registration answer has truthful panel facts (abstract=${abstract})`, () => {
    const w = {
      id: "w1", registration_id: null, filing_registration_id: "r1", registration_todo: false,
      not_registered_reason: { code: "reason", label: "등록 대상 아님 사유", version: "v1" },
      is_abstract: abstract, can_manage: true, withholding: {},
      current: { name: "근무지", status: "CONTINUING", address: abstract ? null : { road_addr_part1: "서울특별시 종로구 세종대로 209" } },
    } as unknown as Workplace;
    const e = { id: "e1", workplaces: [w], registrations: [{ id: "r1", brn: { display: "000-81-00009" } }] } as unknown as LegalEntity;
    const html = renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}><WorkplaceFacts e={e} w={w} onHistory={() => {}} /></QueryClientProvider>);
    expect(html).toContain("등록 대상 아님 사유");
    expect(html).toContain("000-81-00009");
    expect(html).not.toContain("등록증 없음");
    expect(html).not.toContain("주소 입력 필요");
    expect(html).not.toContain("사업자등록 추가");
    if (abstract) expect(html).not.toContain("소재지 수정");
  });
}
