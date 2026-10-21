import { describe, expect, test } from "vitest";
import type { KrAddress, LegalEntity, Workplace } from "@console/api/pending";
import {
  addressLine, entityInput, headcount, headOfficeSettled, primaryRegistration, registrationInput,
  samePlace, unheld, unitRegistration, workplaceInput, workplaceName,
  registrationTodo,
} from "./view";

// The server's shapes are wide; each fixture states only what view.ts reads.
const addr = (road: string, bd?: string, over: object = {}) =>
  ({ source: "JUSO", si_nm: "서울특별시", road_addr_part1: road, bd_mgt_sn: bd ?? null, ...over }) as unknown as KrAddress;
const fv = (value: string) => ({ value, display: value });
const hq = addr("서울특별시 종로구 세종대로 209", "111", { detail: "3층", road_addr_part2: "(세종로)" });

const fullState = {
  name: "주식회사 가나", display_name: "가나", representation_mode: "JOINT", representatives: ["김대표", "이대표"], additional_representatives: 1,
  head_office_address: hq, incorporated_on: "2019-03-04", fiscal_year_end_month: 12, capital_won: 50_000_000,
  vat_unit_mode: "UNIT_TAXATION", vat_unit_mode_basis: "DECLARED", main_ksic: { code: "62010", label: "응용 소프트웨어 개발" },
  main_phone: fv("+8221234567"), priority_support: "SME", priority_support_basis: "SELF_DECLARED", large_group_member: false,
};
const regState = {
  trade_name: "가나", opened_on: "2019-03-04", business_address: hq, unit_taxation: true, tax_office_label: "종로세무서", tax_type: "01",
  business_types: [{ is_main: true, sector_as_printed: "정보통신업", item_as_printed: "소프트웨어", nts_code: "722000", ksic: null }],
  production_factor: "X", issue_reason_kind: "NEW", issue_reason_sub: "S", issue_reason_as_printed: "신규", co_owners: ["박공동"],
  liquor_license_no: "L-1", e_invoice_email: "tax@ganada.example", cert_issued_on: "2019-03-05", tax_office_code: "101",
};
const wpState = {
  name: "본사", address: hq, mail_address: addr("우편 주소"), opened_on: "2019-03-04", representative_name: "김대표", main_product: "SW",
  phone: fv("+8221110000"), fax: fv("+8221110001"), mobile: fv("+821012345678"), email: "hq@ganada.example", is_construction_site: false,
  withholding_mode: "OWN", bulk_filed_on: "2020-01-01", independent_lsa_unit: true, independent_lsa_evidence: "별도 취업규칙", status: "ACTIVE", status_since: "2019-03-04",
};
const wp = (over: object) => ({ id: "w1", registration_id: "r1", is_primary: false, headcount: 0, current: wpState, ...over }) as unknown as Workplace;
const entity = (over: object = {}) =>
  ({
    id: "e1", biz_kind: "CORPORATION", crn: fv("0001111234562"), head_office_workplace_id: null, head_office_has_no_workplace: false,
    current: fullState,
    registrations: [
      { id: "r1", brn: fv("0000000000"), holder_workplace_id: "w1", closed_on: null, current: regState },
      { id: "r2", brn: null, holder_workplace_id: null, closed_on: null, current: { ...regState, unit_taxation: false } },
      { id: "r3", brn: null, holder_workplace_id: null, closed_on: "2026-01-01", current: regState },
    ],
    workplaces: [wp({ id: "w1", headcount: 3 }), wp({ id: "w2", registration_id: "r2", is_primary: true, headcount: 4 })],
    ...over,
  }) as unknown as LegalEntity;

describe("reading an entity", () => {
  test("a workplace's name falls back to nothing", () => {
    expect(workplaceName(wp({ current: undefined }))).toBe("");
    expect(workplaceName(wp({}))).toBe("본사");
  });

  test("the primary workplace's certificate is primary, else the first; headcount sums workplaces", () => {
    expect(primaryRegistration(entity())?.id).toBe("r2");
    expect(primaryRegistration(entity({ workplaces: [wp({ is_primary: true, registration_id: null })] }))?.id).toBe("r1");
    expect(primaryRegistration(entity({ workplaces: [] }))?.id).toBe("r1");
    expect(headcount(entity())).toBe(7);
  });

  test("unheld certificates exclude held and closed ones; the unit registration is the open unit-taxation one", () => {
    expect(unheld(entity()).map((r) => r.id)).toEqual(["r2"]);
    expect(unitRegistration(entity())?.id).toBe("r1");
    const closedUnit = entity().registrations.map((r) => ({ ...r, closed_on: "2026-01-01" }));
    expect(unitRegistration(entity({ registrations: closedUnit }))).toBeUndefined();
    expect(unitRegistration(entity({ registrations: [{ id: "r0", closed_on: null }] }))).toBeUndefined();
  });

  test("the head office is settled by a workplace or by being an office only", () => {
    expect(headOfficeSettled(entity())).toBe(false);
    expect(headOfficeSettled(entity({ head_office_workplace_id: "w1" }))).toBe(true);
    expect(headOfficeSettled(entity({ head_office_has_no_workplace: true }))).toBe(true);
  });

  test("addresses: one line of the present parts; same place by building number, else by road text", () => {
    expect(addressLine(hq)).toBe("서울특별시 종로구 세종대로 209 3층 (세종로)");
    expect(addressLine(addr("부산광역시 중구 중앙대로 2"))).toBe("부산광역시 중구 중앙대로 2");
    expect(addressLine(null)).toBe("");
    expect(samePlace(hq, addr("다른 표기", "111"))).toBe(true);
    expect(samePlace(hq, addr("서울특별시 종로구 세종대로 209", "222"))).toBe(false);
    expect(samePlace(addr(" 같은 길 1 "), addr("같은 길 1", "9"))).toBe(true);
    expect(samePlace(addr("같은 길 1"), addr(" 같은 길 1 "))).toBe(true);
    expect(samePlace(addr("같은 길 1"), addr("같은 길 2"))).toBe(false);
    expect(samePlace(hq, null)).toBe(false);
    expect(samePlace(null, hq)).toBe(false);
  });
});

describe("the current state as the input a dated revision sends", () => {
  test("an entity round-trips every field it holds", () => {
    expect(entityInput(entity())).toEqual({
      biz_kind: "CORPORATION", name: "주식회사 가나", display_name: "가나", representation_mode: "JOINT", representatives: ["김대표", "이대표"],
      additional_representatives: 1, crn: "0001111234562", head_office_address: hq, incorporated_on: "2019-03-04", fiscal_year_end_month: 12,
      capital_won: 50_000_000, directors: undefined, vat_unit_mode: "UNIT_TAXATION", main_ksic: fullState.main_ksic, main_phone: "+8221234567",
      priority_support: "SME", priority_support_basis: "SELF_DECLARED", large_group_member: false,
    });
  });

  test("absent facts are sent as null, never undefined; a derived VAT unit is not sent back", () => {
    const bare = { name: "가나", representatives: ["김대표"], additional_representatives: 0, vat_unit_mode: "UNIT_TAXATION", vat_unit_mode_basis: "DERIVED" };
    expect(entityInput(entity({ crn: null, current: bare }))).toEqual({
      biz_kind: "CORPORATION", name: "가나", display_name: null, representation_mode: "SINGLE", representatives: ["김대표"],
      additional_representatives: 0, crn: null, head_office_address: null, incorporated_on: null, fiscal_year_end_month: null, capital_won: null,
      directors: undefined, vat_unit_mode: null, main_ksic: null, main_phone: null, priority_support: null, priority_support_basis: null, large_group_member: null,
    });
  });

  test("no revision input when the representatives are restricted (it would erase them), or before any state", () => {
    expect(entityInput(entity({ current: { ...fullState, representatives: null } }))).toBeNull();
    expect(entityInput(entity({ current: undefined }))).toBeNull();
    expect(entityInput(entity({ biz_kind: null }))).toBeNull();
  });

  test("a registration round-trips, and is null for an unknown id or a missing required fact", () => {
    expect(registrationInput(entity(), "r1")).toEqual({
      brn: "0000000000", opened_on: "2019-03-04", business_address: hq,
      business_types: [{ is_main: true, sector: "정보통신업", item: "소프트웨어", nts_code: "722000", ksic: null }],
      production_factor: "X", issue_reason_kind: "NEW", issue_reason_sub: "S", issue_reason_as_printed: "신규", co_owners: ["박공동"],
      liquor_license_no: "L-1", unit_taxation: true, e_invoice_email: "tax@ganada.example", cert_issued_on: "2019-03-05", tax_office_code: "101",
      tax_office_label: "종로세무서", tax_type: "01",
    });
    const bare = { trade_name: "가나", opened_on: "2019-03-04", business_address: hq, unit_taxation: false, tax_office_label: "종로세무서", tax_type: "01", business_types: [{ is_main: true, sector_as_printed: "A", item_as_printed: "B" }] };
    expect(registrationInput(entity({ registrations: [{ id: "r1", current: bare }] }), "r1")).toMatchObject({
      brn: null, unit_taxation: false, business_types: [{ is_main: true, sector: "A", item: "B", nts_code: null, ksic: null }],
      production_factor: null, issue_reason_kind: null, issue_reason_sub: null, issue_reason_as_printed: null, co_owners: [],
      liquor_license_no: null, e_invoice_email: null, cert_issued_on: null, tax_office_code: null,
    });
    expect(registrationInput(entity(), "nope")).toBeNull();
    for (const gap of ["opened_on", "business_address", "unit_taxation", "tax_office_label", "tax_type"]) {
      const regs = [{ id: "r1", current: { ...regState, [gap]: null } }];
      expect(registrationInput(entity({ registrations: regs }), "r1"), gap).toBeNull();
    }
    expect(registrationInput(entity({ registrations: [{ id: "r1" }] }), "r1")).toBeNull();
  });

  test("a workplace holding its certificate sends no address of its own; one that does not keeps its address", () => {
    const e = entity();
    const held = workplaceInput(e, e.workplaces[0]!);
    expect(held).toEqual({
      name: "본사", registration_id: "r1", sub_serial: null, same_address_as_registration: true, address: null, mail_address: wpState.mail_address,
      reg_mode: "EXISTING", not_registered_reason: null, is_abstract: false,
      opened_on: "2019-03-04", representative_name: "김대표", main_product: "SW", phone: "+8221110000", fax: "+8221110001", mobile: "+821012345678",
      email: "hq@ganada.example", is_construction_site: false, withholding_mode: "OWN", bulk_filed_on: "2020-01-01", independent_lsa_unit: true, independent_lsa_evidence: "별도 취업규칙",
      status: "ACTIVE", status_since: "2019-03-04", status_until: null,
    });
    expect(workplaceInput(e, e.workplaces[1]!)).toMatchObject({ registration_id: "r2", same_address_as_registration: false, address: hq });
    const bare = wp({ registration_id: null, sub_serial: "0001", current: { name: "지점", opened_on: "2026-09-01", is_construction_site: true, status: "ACTIVE" } });
    expect(workplaceInput(e, bare)).toEqual({
      name: "지점", registration_id: null, sub_serial: "0001", same_address_as_registration: false, address: null, mail_address: null,
      reg_mode: "LATER", not_registered_reason: null, is_abstract: false,
      opened_on: "2026-09-01", representative_name: null, main_product: null, phone: null, fax: null, mobile: null, email: null,
      is_construction_site: true, withholding_mode: null, bulk_filed_on: null, independent_lsa_unit: null, independent_lsa_evidence: null, status: "ACTIVE", status_since: null, status_until: null,
    });
    expect(workplaceInput(e, wp({ registration_id: "gone" }))).toMatchObject({ same_address_as_registration: false, address: hq });
    expect(workplaceInput(e, wp({ current: { ...wpState, opened_on: null } }))).toBeNull();
    expect(workplaceInput(e, wp({ current: undefined }))).toBeNull();
  });

  test("an exempt or abstract answer survives every full-state revision", () => {
    const reason = { code: "REMOTE_TELEWORK", label: "주소 없는 원격 근무지 묶음", version: "2026-10-22" };
    const exempt = wp({
      registration_id: null,
      not_registered_reason: reason,
      is_abstract: true,
      current: { ...wpState, address: null, not_registered_reason: reason, is_abstract: true },
    });
    expect(workplaceInput(entity(), exempt)).toMatchObject({
      registration_id: null,
      reg_mode: "NOT_REQUIRED",
      not_registered_reason: { code: "REMOTE_TELEWORK", version: "2026-10-22" },
      is_abstract: true,
      address: null,
    });
    expect(registrationTodo({ ...exempt, registration_todo: false })).toBe(false);
    expect(registrationTodo(wp({ registration_todo: true }))).toBe(true);
  });
});

test("individual registration revisions carry the certificate name, corporations omit it", () => {
  expect(registrationInput(entity({ biz_kind: "INDIVIDUAL" }), "r1")).toHaveProperty("trade_name", "가나");
  expect(registrationInput(entity(), "r1")).not.toHaveProperty("trade_name");
});
