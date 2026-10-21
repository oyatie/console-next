import { expect, test } from "vitest";
import { emptyDraft, missing, OWNER, SECTIONS, type Draft } from "./draft";
import { planEntityCreate, planRegistration, type Facts } from "./plan";

const today = "2026-10-02";
const addr = { key: "b1", road: "서울특별시 종로구 세종대로 209", zip: "03154", detail: "", verified: true };
const filled = (over: Partial<Draft> = {}): Draft => ({
  ...emptyDraft(),
  bizKind: "CORPORATION", brn: "0000000000", name: "주식회사 가나", representatives: ["김대표"], openedOn: "2019-03-04", crn: "0001111234560",
  businessAddress: addr, headOffice: "SAME", businessTypes: [{ sector: "정보통신업", item: "응용 소프트웨어 개발", ntsCode: null, ksic: null }],
  taxType: "01", unitTaxation: false, taxOfficePrinted: "종로세무서장",
  ...over,
});
const facts = (over: Partial<Facts> = {}): Facts => ({ today, ...over });

test("nothing consequential is defaulted: an empty draft is missing its required facts in every certificate section", () => {
  expect(missing(emptyDraft(), false)).toEqual({ identity: 5, address: 1, business: 1, certificate: 3, registry: 0 });
  const plan = planEntityCreate(emptyDraft(), facts());
  expect(plan.ok).toBe(false);
  if (!plan.ok) expect(plan.errors).toMatchObject({ bizKind: "required", brn: "required", unitTaxation: "required", taxType: "required" });
});

test("a corporation also needs its CRN and where its head office is; a branch certificate asks about the head office workplace", () => {
  expect(missing(filled({ crn: "", headOffice: null }), false)).toMatchObject({ identity: 1, address: 1 });
  expect(missing(filled({ headOffice: "OTHER" }), false)).toMatchObject({ address: 2 });
  const p = planEntityCreate(filled({ headOffice: "OTHER", headOfficeAddress: addr, headOfficeWorkplace: "CREATE_WORKPLACE" }), facts());
  expect(p.ok && p.body.headOffice).toBe("CREATE_WORKPLACE");
});

test("an individual business needs no CRN or head office", () => {
  const p = planEntityCreate(filled({ bizKind: "INDIVIDUAL", crn: "", headOffice: null, coOwners: ["이공동"] }), facts());
  expect(p.ok).toBe(true);
  if (p.ok) {
    expect(p.body.entity.crn).toBeNull();
    expect(p.body.entity.head_office_address).toBeNull();
    expect(p.body.headOffice).toBe("SAME_AS_WORKPLACE");
    expect(p.body.registration.co_owners).toEqual(["이공동"]);
  }
});

test("more than one representative asks how they represent; one is a fact", () => {
  expect(missing(filled({ representatives: ["김대표", "이대표"] }), false).identity).toBe(1);
  const p = planEntityCreate(filled(), facts());
  expect(p.ok && p.body.entity.representation_mode).toBe("SINGLE");
});

test("with a document, issue reason and issue date are required; an issue reason that is none of the listed ones is typed as printed", () => {
  expect(missing(filled(), true).certificate).toBe(2);
  const other = filled({ issueReason: "OTHER_AS_PRINTED", certIssuedOn: "2026-09-01" });
  const p = planEntityCreate(other, facts({ documentId: "doc" }));
  expect(!p.ok && p.errors).toMatchObject({ issueReasonPrinted: "required" });
  const q = planEntityCreate({ ...other, issueReasonPrinted: "사업장 이전" }, facts({ documentId: "doc" }));
  expect(q.ok && q.body.registration.issue_reason_as_printed).toBe("사업장 이전");
  const r = planEntityCreate(filled({ issueReason: "NEW", issueReasonPrinted: "stale" }), facts());
  expect(r.ok && r.body.registration.issue_reason_as_printed).toBeNull();
});

test("the kept certificate goes out as the registration's evidence; none is sent without one", () => {
  const withDoc = planEntityCreate(filled({ issueReason: "NEW", certIssuedOn: "2026-09-01" }), facts({ documentId: "doc" }));
  expect(withDoc.ok && withDoc.body.registration.document_id).toBe("doc");
  const without = planEntityCreate(filled(), facts());
  expect(without.ok && without.body.registration).not.toHaveProperty("document_id");
});

test("format problems show before submit; a check-digit mismatch is held until the user confirms the certificate prints it (worst-case-25)", () => {
  const p = planEntityCreate(filled({ brn: "220816", eInvoiceEmail: "tax@", certIssuedOn: "2019-01-01" }), facts());
  expect(!p.ok && p.errors).toMatchObject({ brn: "brnLength", eInvoiceEmail: "emailInvalid", certIssuedOn: "issuedBeforeOpened" });
  // regression: worst-case-25 a wrong check digit went through with a ✓.
  const held = planEntityCreate(filled({ brn: "0008162516" }), facts());
  expect(!held.ok && held.errors.brn).toBe("brnChecksum");
  expect(planEntityCreate(filled({ brn: "0008162516", brnConfirmed: "0008162516" }), facts()).ok).toBe(true);
});

test("every section has an owner", () => {
  expect(Object.keys(OWNER).sort()).toEqual([...SECTIONS].sort());
});

test("a further certificate does not ask the entity's own facts again", () => {
  const d: Draft = { ...filled(), scope: "registration", bizKind: "CORPORATION", crn: "", headOffice: null };
  expect(missing(d, false)).toMatchObject({ identity: 0, address: 0 });
  const p = planRegistration(d, facts());
  expect(p.ok && p.body.brn).toBe("0000000000");
});

test("a corporation's head office is its certificate's place unless given; a searched address keeps its codes", async () => {
  const { krAddress } = await import("./plan");
  const juso = { source: "JUSO" as const, road_addr_part1: "서울특별시 종로구 세종대로 209", si_nm: "서울특별시", zip_no: "03154", bd_mgt_sn: "1111010100100130000000001" };
  const p = planEntityCreate(filled({ businessAddress: { ...addr, detail: "3층", juso } }), facts());
  expect(p.ok && p.body.entity.head_office_address).toMatchObject({ source: "JUSO", bd_mgt_sn: juso.bd_mgt_sn, detail: "3층" });
  expect(p.ok && p.body.registration.business_types).toEqual([{ is_main: true, sector: "정보통신업", item: "응용 소프트웨어 개발", nts_code: null, ksic: null }]);
  expect(krAddress({ road: "부산광역시 중구 중앙대로 2", zip: "", detail: "", verified: false })).toEqual({ source: "MANUAL_UNVERIFIED", road_addr_part1: "부산광역시 중구 중앙대로 2", zip_no: null, si_nm: "부산광역시", sgg_nm: "중구", detail: null, as_printed: null });
  expect(krAddress({ road: "경기도 성남시 분당구 판교역로 166", zip: "13529", detail: "", verified: false })).toMatchObject({ si_nm: "경기도", sgg_nm: "성남시 분당구" });
  // 세종 has no district: none is invented, and the server names the missing field.
  expect(krAddress({ road: "세종특별자치시 한누리대로 2130", zip: "30151", detail: "", verified: false })).toMatchObject({ si_nm: "세종특별자치시", sgg_nm: null });
});

test("a further certificate of an existing entity counts only the fields it shows", () => {
  const branch = { ...filled({ scope: "registration", representatives: [""], crn: "" }), headOffice: null };
  expect(missing(branch, false)).toEqual({ identity: 0, address: 0, business: 0, certificate: 0, registry: 0 });
});

// Edges the mutation run found unpinned (npm run mutants).
test("typed text goes out trimmed, empty optional facts as null, and only the facts that apply", () => {
  const p = planEntityCreate(filled({
    name: " 주식회사 가나 ", representatives: [" 김대표 ", " ", "이대표"], representationMode: "JOINT", incorporatedOn: "", certIssuedOn: "",
    productionFactor: "  ", taxOfficePrinted: " 종로세무서장 ", coOwners: ["박공동"], headOffice: "OTHER", headOfficeWorkplace: "OFFICE_ONLY",
    headOfficeAddress: { road: "서울특별시 중구 세종대로 110", zip: "04524", detail: " 2층 ", verified: false },
    businessTypes: [{ sector: " 정보통신업 ", item: " 개발 ", ntsCode: null, ksic: null }, { sector: "도매", item: "부품", ntsCode: null, ksic: null }],
  }), facts());
  expect(p.ok).toBe(true);
  if (!p.ok) return;
  expect(p.body.entity).toMatchObject({ name: "주식회사 가나", representatives: ["김대표", "이대표"], representation_mode: "JOINT", incorporated_on: null, directors: [] });
  expect(p.body.entity.head_office_address).toMatchObject({ road_addr_part1: "서울특별시 중구 세종대로 110", sgg_nm: "중구", detail: "2층" });
  expect(p.body.headOffice).toBe("OFFICE_ONLY");
  expect(p.body.registration).not.toHaveProperty("trade_name");
  expect(p.body.registration).toMatchObject({ production_factor: null, cert_issued_on: null, tax_office_label: "종로세무서장", co_owners: [], issue_reason_sub: null });
  expect(p.body.registration.business_types.map((b) => [b.is_main, b.sector, b.item])).toEqual([[true, "정보통신업", "개발"], [false, "도매", "부품"]]);
  expect(planEntityCreate(filled(), facts())).toMatchObject({ body: { headOffice: "SAME_AS_WORKPLACE" } });
  const dated = planEntityCreate(filled({ incorporatedOn: "2019-03-04", certIssuedOn: "2019-03-05" }), facts());
  expect(dated.ok && [dated.body.entity.incorporated_on, dated.body.registration.cert_issued_on]).toEqual(["2019-03-04", "2019-03-05"]);
  const fixed = planEntityCreate(filled({ issueReason: "CORRECTION", correction: "RELOCATION" }), facts());
  expect(fixed.ok && fixed.body.registration.issue_reason_sub).toBe("RELOCATION");
  expect(planEntityCreate(filled({ issueReason: "NEW", correction: "RELOCATION" }), facts())).toMatchObject({ body: { registration: { issue_reason_sub: null } } });
  const solo = planEntityCreate(filled({ bizKind: "INDIVIDUAL", crn: "", headOffice: null, coOwners: [" 이공동 ", ""] }), facts());
  expect(solo.ok && solo.body.registration.co_owners).toEqual(["이공동"]);
});

test("a hand-typed or list-picked district: province, at most two si/gun/gu words, then the dong", async () => {
  const { krAddress } = await import("./plan");
  const typed = (road: string) => krAddress({ road, zip: "", detail: "", verified: false });
  expect(typed(" 부산광역시  중구 중앙대로 2")).toMatchObject({ si_nm: "부산광역시", sgg_nm: "중구" });
  expect(typed("경기도 성남시 분당구 구미구 1")).toMatchObject({ sgg_nm: "성남시 분당구" });
  expect(typed("세종특별자치시 시청대로 1")).toMatchObject({ sgg_nm: null }); // 시 only counts as the last syllable
  const pick = (label: string) => krAddress({ road: "아무 길 1", zip: "", detail: "", verified: false, district: { code: "1111053000", label, version: "1" } });
  expect(pick("서울특별시 종로구 사직동")).toMatchObject({ si_nm: "서울특별시", sgg_nm: "종로구", emd_nm: "사직동", adm_cd: "1111053000" });
  expect(pick("경기도 성남시 분당구")).toMatchObject({ sgg_nm: "성남시 분당구", emd_nm: null });
  expect(pick("세종특별자치시 한솔동")).toMatchObject({ si_nm: "세종특별자치시", sgg_nm: null, emd_nm: "한솔동" });
});

test("individual first and further certificates send their printed trade name", () => {
  const d = filled({ bizKind: "INDIVIDUAL", name: " 가나상회 2호점 ", crn: "", headOffice: null });
  expect(planEntityCreate(d, facts())).toMatchObject({ ok: true, body: { registration: { trade_name: "가나상회 2호점" } } });
  expect(planRegistration({ ...d, scope: "registration" }, facts())).toMatchObject({ ok: true, body: { trade_name: "가나상회 2호점" } });
});
