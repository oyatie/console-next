import { expect, test } from "vitest";
import type { LegalEntity } from "@console/api/pending";
import { entityPartFrom, fromProblem, isNewCertificate, printedReason, reissueBody, reissueFrom } from "./reissue";

const addr = (road: string) => ({ source: "MANUAL_UNVERIFIED", road_addr_part1: road, si_nm: "서울특별시" });
const entity = {
  id: "e1", biz_kind: "CORPORATION", crn: { value: "0000000000018", display: "000000-0000018" }, scheduled: [],
  current: { version: 3, effective_from: "2026-01-01", name: "주식회사 가나", representation_mode: "SINGLE", representatives: ["홍길동"], additional_representatives: 0, head_office_address: addr("서울 테헤란로 152") },
  registrations: [{
    id: "r1", brn: { value: "0008100028", display: "000-81-00028" }, current: {
      version: 2, effective_from: "2025-06-01", status: "CONTINUING", opened_on: "2020-03-02", business_address: addr("서울 테헤란로 152"), unit_taxation: false,
      tax_office_label: "삼성세무서", tax_type: "01", business_types: [], co_owners: [], issue_reason_kind: "NEW", issue_reason_as_printed: "신규", cert_issued_on: "2020-03-02",
    },
  }],
} as unknown as LegalEntity;

test("the printed 발급 사유 follows the reason: 재발급, 정정 with the one changed fact's sub-reason (기타 for several), or as printed", () => {
  expect(printedReason("CERT_REISSUE", [])).toEqual({ issue_reason_kind: "REISSUE", issue_reason_sub: null, issue_reason_as_printed: null });
  expect(printedReason("CERT_CHANGE_REPORT", ["representatives"])).toMatchObject({ issue_reason_kind: "CORRECTION", issue_reason_sub: "REPRESENTATIVE" });
  expect(printedReason("CERT_CHANGE_REPORT", ["businessAddress", "headOffice"])).toMatchObject({ issue_reason_sub: "RELOCATION" });
  expect(printedReason("CERT_CHANGE_REPORT", ["businessAddress", "representatives"])).toMatchObject({ issue_reason_sub: "OTHER" });
  expect(printedReason("CERT_ERROR_CORRECTION", ["name"])).toEqual({});
});

test("a change holds from its 정정일, a reissue from its issue date (never before the state in force), a correction rewrites that state", () => {
  expect(reissueFrom("CERT_CHANGE_REPORT", "2026-10-02", "2026-10-01", "2025-06-01")).toBe("2026-10-01");
  expect(reissueFrom("CERT_REISSUE", "2026-10-02", "", "2025-06-01")).toBe("2026-10-02");
  expect(reissueFrom("CERT_REISSUE", "2025-01-02", "", "2025-06-01")).toBe("2025-06-01");
  expect(reissueFrom("CERT_ERROR_CORRECTION", "2026-10-02", "2026-10-01", "2025-06-01")).toBe("2025-06-01");
  expect(fromProblem("CERT_CHANGE_REPORT", "2026-10-15", "2025-06-01", "2026-10-14")).toBe("future");
  expect(fromProblem("CERT_CHANGE_REPORT", "2025-05-31", "2025-06-01", "2026-10-14")).toBe("beforeInForce");
  expect(fromProblem("CERT_CHANGE_REPORT", "2025-06-01", "2025-06-01", "2026-10-14")).toBeNull();
  expect(fromProblem("CERT_REISSUE", "2099-01-01", "2025-06-01", "2026-10-14")).toBeNull();
});

test("one request: the registration's full state with the new facts, the 법인's only when the certificate changed what it records", () => {
  const picked = { docId: "d2", reason: "CERT_CHANGE_REPORT" as const, from: "2026-10-01", issued: "2026-10-02", changed: ["businessAddress" as const, "representatives" as const] };
  const body = reissueBody(entity, "r1", { ...picked, reg: { business_address: addr("부산 센텀중앙로 79") as never }, entity: { representatives: ["김대표"] } })!;
  expect(body).toMatchObject({ document_id: "d2", reason: "CERT_CHANGE_REPORT", effective_from: "2026-10-01" });
  expect(body.registration).toMatchObject({ expected_version: 2, status: "CONTINUING", cert_issued_on: "2026-10-02", issue_reason_kind: "CORRECTION", issue_reason_sub: "OTHER", tax_office_label: "삼성세무서" });
  expect(body.registration.business_address?.road_addr_part1).toBe("부산 센텀중앙로 79");
  expect(body.entity).toMatchObject({ expected_version: 3, representatives: ["김대표"], name: "주식회사 가나" });
  // The revision envelope's own date and reason are the request's, never repeated inside the records.
  expect(body.registration).not.toHaveProperty("effective_from");
  expect(body.entity).not.toHaveProperty("reason_code");
  const regOnly = reissueBody(entity, "r1", { ...picked, changed: ["businessAddress"], reg: {}, entity: {} })!;
  expect(regOnly).not.toHaveProperty("entity");
  expect(reissueBody(entity, "nope", { ...picked, reg: {}, entity: {} })).toBeNull();
});

test("only a newly issued certificate is new: never the one in force nor one superseded", () => {
  expect(isNewCertificate({ registration_id: null, superseded_at: null }, "r1")).toBe(true);
  expect(isNewCertificate({ registration_id: "r1", superseded_at: null }, "r1")).toBe(false);
  expect(isNewCertificate({ registration_id: "r1", superseded_at: "2026-10-01T00:00:00Z" }, "r1")).toBe(false);
  expect(isNewCertificate({ registration_id: null, superseded_at: "2026-10-01T00:00:00Z" }, "r1")).toBe(false);
});

test("the 법인's part: refused under a scheduled 법인 state (it would be undone), moved to a later state in force, else the change date", () => {
  expect(entityPartFrom(entity, "2026-10-01")).toEqual({ from: "2026-10-01" });
  expect(entityPartFrom(entity, "2025-10-01")).toEqual({ from: "2026-01-01" });
  const scheduled = { ...entity, scheduled: [{ ...entity.current!, version: 4, effective_from: "2026-11-14" }] } as LegalEntity;
  expect(entityPartFrom(scheduled, "2026-10-01")).toEqual({ scheduled: "2026-11-14" });
});
