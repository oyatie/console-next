import { beforeAll, expect, test } from "vitest";
import { loadCatalog } from "@console/i18n";
import { changeLine, directorsText, historyValue, kindName, kindTaken } from "./present";

beforeAll(() => loadCatalog("ko"));

test("an insurer's relation change reads as the insurer and its field, its status by label", () => {
  expect(changeLine({ field: "insurance.NHIS.status", before: "ESTABLISHED_NUMBER_PENDING", after: "ESTABLISHED" })).toBe("건강보험 상태: 성립 · 번호 입력 전 → 성립");
  expect(changeLine({ field: "insurance.IACI.mgmt_no", before: null, after: "12345678901" })).toBe("산재보험 관리번호: — → 12345678901");
  expect(changeLine({ field: "trade_name", before: "가나", after: "다라" })).toBe("상호: 가나 → 다라");
});

test("regression (r3 company-24): history values read in Korean, never raw keys, enums or E.164", () => {
  expect(changeLine({ field: "representation_mode", before: "SINGLE", after: "SEVERAL" })).not.toMatch(/SINGLE|SEVERAL/);
  expect(changeLine({ field: "status", before: "CONTINUING", after: "CLOSED" })).not.toMatch(/CONTINUING|CLOSED/);
  expect(changeLine({ field: "vat_unit_mode_basis", before: null, after: "SINGLE_REGISTRATION" })).not.toMatch(/vat_unit_mode_basis|SINGLE_REGISTRATION/);
  expect(changeLine({ field: "insurance.NPS.unit_mode", before: null, after: "OWN" })).not.toMatch(/OWN/);
  expect(changeLine({ field: "additional_representatives", before: null, after: "0" })).not.toMatch(/additional_representatives/);
  expect(historyValue("main_phone", "+8225550142")).toBe("02-555-0142");
  expect(historyValue("status_since", "2026-10-07")).not.toBe("2026-10-07");
});

test("regression (r3 company-26): an officer with no role yet reads as the name, never 「null」", () => {
  expect(directorsText([{ role: null as never, name: "이감사" }])).toBe("이감사");
  expect(directorsText([{ role: null as never, name: "" }])).toBe("—");
});

const kinds = [
  { code: "STORE", label: null, platform: true, active: true },
  { code: "FACTORY", label: "생산동", platform: true, active: true },
  { code: "0b5f1c9e-0000-4000-8000-000000000001", label: "직영점", platform: false, active: true },
];

test("a label any kind shows is taken: a default's catalog label, a relabelled default, a tenant label; case and spaces aside", () => {
  expect(kindTaken(kinds, "매장")).toBe(true); // STORE's catalog label: the server cannot see it
  expect(kindTaken(kinds, " 생산동 ")).toBe(true);
  expect(kindTaken(kinds, "공장")).toBe(false); // FACTORY now reads 생산동
  expect(kindTaken(kinds, "직영점", "0b5f1c9e-0000-4000-8000-000000000001")).toBe(false); // its own label
  expect(kindTaken(kinds, "아울렛")).toBe(false);
});

test("a kind code reads as its label; a tenant kind's id is never shown", () => {
  expect(kindName(kinds, "STORE")).toBe("매장");
  expect(kindName(kinds, "0b5f1c9e-0000-4000-8000-000000000001")).toBe("직영점");
});

// Regression (parity S3): a refused entity write read only as 「요청을 처리하지 못했습니다」.
test("regression: a refused entity write names each field and its reason, or words its code", async () => {
  const { ApiError } = await import("@console/api");
  const { fieldRefusal } = await import("./present");
  const refused = Object.assign(new ApiError(422, "validation_failed", "요청을 처리하지 못했습니다."), { fields: [{ field: "cert_issued_on", code: "issued_before_opened" }, { field: "business_types[0].sector", code: "required" }] });
  expect(fieldRefusal(refused)("validation_failed")).toBe("발급일: 발급일이 개업연월일보다 앞섭니다. 발급일도 함께 정정하십시오 · 사업의 종류: 필수 항목입니다");
  const unknown = Object.assign(new ApiError(422, "validation_failed", "x"), { fields: [{ field: "zzz", code: "zzz_new" }] });
  expect(fieldRefusal(unknown)("validation_failed")).toBe("입력한 값: 이 값은 받아들여지지 않았습니다");
  const closed = new ApiError(409, "legal_entity_not_open", "요청을 처리하지 못했습니다.");
  expect(fieldRefusal(closed)("legal_entity_not_open")).toBe("종료된 법인이라 더는 수정할 수 없습니다.");
  // A code the slice has no words for falls through to the shared copy.
  expect(fieldRefusal(closed)("stale_revision")).toBeUndefined();
});

// ent-cert-renewal verify #2: the reissue's date refusals each read in their own words, never the fallback.
test("a reissue refused on its date names why: before the state in force, or under a scheduled change", async () => {
  const { ApiError } = await import("@console/api");
  const { fieldRefusal } = await import("./present");
  const said = (code: string) => fieldRefusal(Object.assign(new ApiError(422, "validation_failed", "x"), { fields: [{ field: "effective_from", code }] }))("validation_failed");
  expect(said("before_state_in_force")).toContain("지금 등록증 내용이 시작된 날보다 앞선 날짜입니다");
  expect(said("registration_change_scheduled")).toContain("이 등록증에 예약된 변경보다 앞선 날짜");
  expect(said("entity_change_scheduled")).toContain("법인에 예약된 변경이 있어");
  for (const code of ["before_state_in_force", "registration_change_scheduled", "entity_change_scheduled"]) expect(said(code)).not.toContain("이 값은 받아들여지지 않았습니다");
});
