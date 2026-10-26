// SPDX-License-Identifier: LicenseRef-Proprietary
import { beforeAll, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { loadCatalog } from "@console/i18n";
import type { Revision } from "@console/api/pending";
import { RevisionItems } from "./history-tab";

beforeAll(() => loadCatalog("ko"));

const revisions: Revision[] = [
  { version: 3, effective_from: "2026-10-20", recorded_at: "2026-10-21T00:00:00Z", change_mode: "SETUP", actor_kind: "OPS_ACCOUNT", changes: [
    { field: "insurance.NHIS.status", before: "ESTABLISHED_NUMBER_PENDING", after: "ESTABLISHED" },
    { field: "insurance.IACI.mgmt_no", before: null, after: "12345678901" },
    { field: "trade_name", before: "가나", after: "다라" },
  ] },
  { version: 2, effective_from: "2026-10-19", recorded_at: "2026-10-20T00:00:00Z", change_mode: "SETUP", reason_code: "VAT_UNIT_DERIVED", changes: [] },
];

test("shared revision history renders outside the entity route", () => {
  expect(() => renderToStaticMarkup(<RevisionItems items={[]} />)).not.toThrow();
});

test("revision history preserves server order, insurer labels, before/after and the catalog's null value", () => {
  const out = renderToStaticMarkup(<RevisionItems items={revisions} />);
  const fields = [...out.matchAll(/<dt>(.*?)<\/dt><dd>(.*?)<\/dd>/g)].map(([, name, values]) => [name, values!.replace(/<[^>]+>/g, "")]);
  expect(fields).toMatchInlineSnapshot(`
    [
      [
        "건강보험 상태",
        "변경 전: 성립 · 번호 입력 전 → 변경 후: 성립",
      ],
      [
        "산재보험 관리번호",
        "변경 전: — → 변경 후: 12345678901",
      ],
      [
        "상호",
        "변경 전: 가나 → 변경 후: 다라",
      ],
    ]
  `);
  expect(out.indexOf("2026. 10. 21.")).toBeLessThan(out.indexOf("2026. 10. 20."));
  expect(out).toContain("운영 계정");
  expect(out).not.toContain("긴급 권한");
  expect(out.match(/<li\b/g)).toHaveLength(revisions.length);
});

test("field diffs keep upstream Korean boolean, enum and fallback labels", () => {
  const out = renderToStaticMarkup(<RevisionItems items={[{ ...revisions[0]!, changes: [
    { field: "is_construction_site", before: "false", after: "true" },
    { field: "insurance.NPS.unit_mode", before: null, after: "OWN" },
    { field: "future_field", before: null, after: "사용자 기록" },
  ] }]} />);
  expect(out).toContain("건설 사업장 여부");
  expect(out).toContain("아님");
  expect(out).toContain("해당");
  expect(out).toContain("국민연금");
  expect(out).toContain("사용자 기록");
  expect(out.replace(/<[^>]+>/g, "")).not.toMatch(/false|true|NPS|OWN|future_field/);
});

test("registration links retain the upstream changed message without exposing record ids", () => {
  const out = renderToStaticMarkup(<RevisionItems items={[{ ...revisions[0]!, changes: [
    { field: "trade_name", before: "가나", after: "다라" },
    { field: "registration_id", before: "old-registration-id", after: "new-registration-id" },
    { field: "main_product", before: "이전 제품", after: "현재 제품" },
  ] }]} />);
  expect(out).toContain("사업자등록증 변경");
  expect(out).not.toMatch(/old-registration-id|new-registration-id|registration_id/);
  expect(out.indexOf("다라")).toBeLessThan(out.indexOf("사업자등록증 변경"));
  expect(out.indexOf("사업자등록증 변경")).toBeLessThan(out.indexOf("현재 제품"));
});
