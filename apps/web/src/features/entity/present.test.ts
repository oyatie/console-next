import { beforeAll, expect, test } from "vitest";
import { i18n, loadCatalog } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { entityInput, registrationInput, workplaceInput } from "./domain/view";
import { changeLine, directorsText, fieldLabel, historyValue, kindName, kindTaken } from "./present";

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

test("every entity, registration, workplace and backend diff field has a Korean and English label, never a raw snake_case key", async () => {
  const ent = {
    biz_kind: "CORPORATION",
    current: { name: "가나", representatives: [] },
    registrations: [
      {
        id: "r1",
        current: {
          opened_on: "2020-01-01",
          business_address: { postal_code: "06236", road_address: "테헤란로 1" },
          unit_taxation: false,
          tax_office_label: "역삼세무서장",
          tax_type: "01",
          business_types: [],
        },
      },
    ],
    workplaces: [],
  };
  const keys = new Set([
    ...Object.keys(entityInput(ent as never)!),
    ...Object.keys(registrationInput(ent as never, "r1")!),
    ...Object.keys(workplaceInput(ent as never, { id: "w1", current: { name: "본사", opened_on: "2020-01-01" } } as never)!),
    "main_ksic_code",
    "main_ksic_label",
    "main_ksic_version",
    "tax_office_code",
    "co_owners",
    "independent_lsa_evidence",
  ]);
  const subkeys = [
    "status",
    "mgmt_no",
    "established_on",
    "unit_mode",
    "main_workplace_id",
    "nps_separate_application",
    "nhis_unit_workplace_code",
    "nhis_branch_office_code",
    "nhis_workplace_class",
    "iaci_business_type_code",
    "iaci_business_type_label",
    "iaci_insurance_year",
    "iaci_business_form",
    "iaci_term_from",
    "iaci_term_to",
    "prime_contractor_mgmt_no",
  ];
  try {
    for (const locale of ["ko", "en"] as const) {
      await loadCatalog(locale);
      i18n.set(locale);
      for (const key of keys) {
        const label = fieldLabel(key);
        expect(label, `${locale}:${key}`).not.toBeNull();
        expect(label, `${locale}:${key}`).toMatch(/\S/);
        if (locale === "ko") expect(label, `${locale}:${key}`).not.toBe(key);
        expect(label, `${locale}:${key}`).not.toMatch(/[a-z]+_[a-z_]+/);
      }
      for (const key of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
        expect(fieldLabel(key), `${locale}:${key}`).toBeNull();
      }
      for (const insurer of ["NPS", "NHIS", "EI", "IACI"]) {
        for (const sub of subkeys) {
          const line = changeLine({ field: `insurance.${insurer}.${sub}`, before: null, after: "1" });
          if (locale === "ko") {
            expect(line, `${locale}:insurance.${insurer}.${sub}`).not.toContain(sub);
            expect(line, `${locale}:insurance.${insurer}.${sub}`).not.toContain(insurer);
          }
          expect(line, `${locale}:insurance.${insurer}.${sub}`).not.toMatch(/[a-z]+_[a-z_]+/);
        }
      }
    }
  } finally {
    i18n.set("ko");
  }
});

const RAW_KEY = /[a-z]+_[a-z_]+/;
const RAW_BOOL = /\b(true|false)\b/;
const UPPER_CASE = /\b[A-Z][A-Z0-9_]+\b/;

test("boolean-shaped free text stays as written in Korean and English history", async () => {
  try {
    for (const locale of ["ko", "en"] as const) {
      await loadCatalog(locale);
      i18n.set(locale);
      for (const field of ["name", "trade_name", "english_name", "representative_name", "main_product", "issue_reason_as_printed", "insurance.NPS.mgmt_no", "unknown_field"]) {
        for (const value of ["true", "false"]) {
          expect(historyValue(field, value), `${locale}:${field}=${value}`).toBe(value);
          expect(changeLine({ field, before: value, after: value }), `${locale}:${field}=${value}`).toContain(`: ${value} → ${value}`);
        }
      }
    }
  } finally {
    i18n.set("ko");
  }
});

test("entity history booleans and workplace/entity enums read in Korean and English, never raw tokens", async () => {
  expect(changeLine({ field: "is_construction_site", before: null, after: "false" })).toBe("건설 사업장 여부: — → 아님");
  expect(changeLine({ field: "is_construction_site", before: null, after: "true" })).toBe("건설 사업장 여부: — → 해당");

  const boolFields = [
    "is_construction_site",
    "unit_taxation",
    "independent_lsa_unit",
    "same_address_as_registration",
    "large_group_member",
    "insurance.NPS.nps_separate_application",
  ] as const;
  const enumCases: readonly [string, string, string, string][] = [
    ["withholding_mode", "HEAD_OFFICE", "본점에서 함께 신고", "Filed with the head office"],
    ["withholding_mode", "OWN_INDEPENDENT_ACCOUNTS", "이 사업장에서 따로 신고 (독립채산)", "Filed by this workplace (independent accounts)"],
    ["withholding_mode", "HEAD_OFFICE_BULK", "본점 일괄 납부 승인에 따름 (원천징수사무처리규정 §34)", "Under approved bulk filing at the head office (withholding rules §34)"],
    ["priority_support", "YES", "해당", "Yes"],
    ["priority_support", "NO", "해당 없음", "No"],
    ["priority_support_basis", "ANNEX_1", "고용보험법 시행령 별표 1", "Employment Insurance Act Enforcement Decree, annex 1"],
    ["priority_support_basis", "SME_ACT", "중소기업기본법 제2조", "Framework Act on Small and Medium Enterprises art. 2"],
    ["priority_support_basis", "GRACE_5Y", "유예기간 5년", "Five-year grace period"],
    ["priority_support_basis", "NOT_ELIGIBLE", "해당 없음", "Not eligible"],
    ["biz_kind", "CORPORATION", "법인사업자", "Corporation"],
    ["biz_kind", "INDIVIDUAL", "개인사업자", "Sole proprietor"],
    ["biz_kind", "ID_NUMBER_ORG", "고유번호 단체", "Organization with an ID number"],
    ["representation_mode", "SINGLE", "단독대표", "Sole representative"],
    ["representation_mode", "SEVERAL", "각자대표", "Each represents alone"],
    ["representation_mode", "JOINT", "공동대표", "Joint representation"],
    ["status", "CONTINUING", "계속", "Active"],
    ["status", "SUSPENDED", "휴업", "Suspended"],
    ["status", "CLOSED", "폐업", "Closed"],
    ["issue_reason_kind", "NEW", "신규", "New"],
    ["issue_reason_kind", "REISSUE", "재발급", "Reissue"],
    ["issue_reason_kind", "CORRECTION", "정정", "Correction"],
    ["issue_reason_kind", "OTHER_AS_PRINTED", "기타 (표기대로)", "Other (as printed)"],
    ["issue_reason_sub", "TRADE_NAME", "상호 변경", "Trade name change"],
    ["issue_reason_sub", "RELOCATION", "사업장 이전", "Relocation"],
    ["issue_reason_sub", "INDUSTRY", "업종 변경", "Industry change"],
    ["issue_reason_sub", "UNIT_TAXATION", "사업자 단위 과세 변경", "Unit taxation change"],
    ["issue_reason_sub", "REPRESENTATIVE", "대표자 변경", "Representative change"],
    ["issue_reason_sub", "OTHER", "기타", "Other"],
    ["tax_type", "01", "일반과세자", "General taxpayer"],
    ["tax_type", "02", "간이과세자", "Simplified taxpayer"],
    ["tax_type", "03", "과세특례자", "Special-case taxpayer"],
    ["tax_type", "04", "면세사업자", "VAT-exempt business"],
    ["tax_type", "05", "수익사업 없는 비영리법인", "Non-profit with no taxable business"],
    ["tax_type", "06", "고유번호가 부여된 단체", "Organization with an ID number"],
    ["tax_type", "07", "간이과세자(세금계산서 발급)", "Simplified taxpayer (issues tax invoices)"],
    ["vat_unit_mode", "PER_WORKPLACE", "사업장별", "Per workplace"],
    ["vat_unit_mode", "CONSOLIDATED_PAYMENT", "주사업장 총괄 납부", "Consolidated payment"],
    ["vat_unit_mode", "UNIT_TAXATION", "사업자 단위 과세", "Business-unit taxation"],
    ["vat_unit_mode_basis", "DECLARED", "관리자가 고름", "Chosen by an administrator"],
    ["vat_unit_mode_basis", "SINGLE_REGISTRATION", "등록 1건이며 사업자 단위 과세가 아니어서 정해짐", "Set because there is one registration without unit taxation"],
    ["vat_unit_mode_basis", "CERTIFICATE_UNIT_TAXATION", "등록증의 사업자 단위 과세 적용 항목에 따름", "Follows the certificate’s unit-taxation item"],
    ["insurance.NHIS.status", "NOT_ESTABLISHED", "아직 없음", "Not yet"],
    ["insurance.NHIS.status", "ESTABLISHED_NUMBER_PENDING", "성립 · 번호 입력 전", "Established · number to come"],
    ["insurance.NHIS.status", "ESTABLISHED", "성립", "Established"],
    ["insurance.NHIS.status", "ENDED", "소멸", "Ended"],
    ["insurance.NPS.unit_mode", "OWN", "이 사업장 단독", "This workplace alone"],
    ["insurance.NPS.unit_mode", "PART_OF", "다른 사업장에 포함", "Part of another workplace"],
    ["insurance.NHIS.nhis_workplace_class", "1", "공무원사업장", "Civil service workplace"],
    ["insurance.NHIS.nhis_workplace_class", "3", "사립학교교직원사업장", "Private school staff workplace"],
    ["insurance.NHIS.nhis_workplace_class", "5", "군 기관", "Military institution"],
    ["insurance.NHIS.nhis_workplace_class", "7", "일반근로자사업장", "General employee workplace"],
    ["insurance.IACI.iaci_business_form", "CONTINUING", "계속사업", "Continuing"],
    ["insurance.IACI.iaci_business_form", "FIXED_TERM", "유기사업", "Fixed-term"],
  ];

  try {
    for (const locale of ["ko", "en"] as const) {
      await loadCatalog(locale);
      i18n.set(locale);
      for (const field of boolFields) {
        for (const val of ["true", "false"] as const) {
          const line = changeLine({ field, before: null, after: val });
          expect(line, `${locale}:${field}=${val}`).toContain(`— → ${locale === "ko" ? (val === "true" ? "해당" : "아님") : (val === "true" ? "Yes" : "No")}`);
          expect(line, `${locale}:${field}=${val}`).not.toMatch(RAW_KEY);
          expect(line, `${locale}:${field}=${val}`).not.toMatch(RAW_BOOL);
          expect(line, `${locale}:${field}=${val}`).not.toMatch(UPPER_CASE);
        }
      }
      for (const [field, val, ko, en] of enumCases) {
        const before = changeLine({ field, before: val, after: null });
        const after = changeLine({ field, before: null, after: val });
        const expected = locale === "ko" ? ko : en;
        expect(before, `${locale}:${field}=${val}`).toContain(`: ${expected} → —`);
        expect(after, `${locale}:${field}=${val}`).toContain(`: — → ${expected}`);
        for (const line of [before, after]) {
          expect(line, `${locale}:${field}=${val}`).not.toMatch(RAW_KEY);
          expect(line, `${locale}:${field}=${val}`).not.toMatch(RAW_BOOL);
          if (locale === "ko") expect(line, `${locale}:${field}=${val}`).not.toMatch(UPPER_CASE);
          expect(line, `${locale}:${field}=${val}`).not.toContain(val);
        }
      }
    }

    i18n.set("en");

    const enFields = [
      "is_construction_site",
      "unit_taxation",
      "independent_lsa_unit",
      "same_address_as_registration",
    ] as const;
    for (const field of enFields) {
      expect(fieldLabel(field), `en:${field}`).not.toBeNull();
      const lineFalse = changeLine({ field, before: null, after: "false" });
      expect(lineFalse, `en:${field}=false`).not.toContain(field);
      expect(lineFalse, `en:${field}=false`).not.toContain("false");
      expect(lineFalse, `en:${field}=false`).not.toMatch(RAW_KEY);
      expect(lineFalse, `en:${field}=false`).not.toMatch(RAW_BOOL);

      const lineTrue = changeLine({ field, before: null, after: "true" });
      expect(lineTrue, `en:${field}=true`).not.toContain(field);
      expect(lineTrue, `en:${field}=true`).not.toContain("true");
      expect(lineTrue, `en:${field}=true`).not.toMatch(RAW_KEY);
      expect(lineTrue, `en:${field}=true`).not.toMatch(RAW_BOOL);
    }

    const enFalse = changeLine({ field: "is_construction_site", before: null, after: "false" });
    const enTrue = changeLine({ field: "is_construction_site", before: null, after: "true" });
    expect(enFalse).toBe("Construction site: — → No");
    expect(enTrue).toBe("Construction site: — → Yes");
  } finally {
    i18n.set("ko");
  }
});


test("a director reads by role label with a formatted date; values outside a closed set stay as stored", async () => {
  try {
    for (const [locale, role] of [["ko", "대표이사"], ["en", "Representative director"]] as const) {
      await loadCatalog(locale);
      i18n.set(locale);
      const line = changeLine({ field: "directors[0]", before: null, after: "REPRESENTATIVE_DIRECTOR 김대표 2026-10-15" });
      expect(line).toContain(`${role} 김대표 ${fmtDate("2026-10-15")}`);
      expect(line).not.toMatch(/REPRESENTATIVE_DIRECTOR/);
      expect(historyValue("directors", "ROLE_FROM_LATER 김대표")).toBe("ROLE_FROM_LATER 김대표");
      // Drift stays visible (labels.ts): an unknown code, a prototype key, or text in a yes/no field as written.
      for (const v of ["OWN", "BOGUS", "toString", "constructor"]) expect(historyValue("withholding_mode", v)).toBe(v);
      for (const v of ["TARGET", "maybe"]) expect(historyValue("priority_support", v)).toBe(v);
      expect(historyValue("is_construction_site", "maybe")).toBe("maybe");
    }
  } finally {
    i18n.set("ko");
  }
});
