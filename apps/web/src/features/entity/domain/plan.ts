// Planners for registering a legal entity from its first certificate, and a further certificate of an
// existing entity (ADR-010): the draft and the section confirmations in, the request body or the reasons it
// cannot be sent out. Pure.
import type { CodeRef, CreateRegistrationRequest, KrAddress, LegalEntityInput } from "@console/api/pending";
import { phoneE164 } from "../../../lib/pure/formats";
import { missing, problems, representativeCount, type AddrDraft, type Draft, type FieldKey, type Problem, type Section } from "./draft";

export type Facts = {
  today: string;
  /** The uploaded certificate, if any: issue reason and date become required. */
  documentId?: string;
};
export type Refused = { ok: false; errors: Partial<Record<FieldKey, Problem>>; missing: Record<Section, number> };
/**
 * The first certificate creates the entity, then its registration (two server calls, the second retried alone
 * if it fails). `headOffice`: whether the head office is this certificate's place, gets a workplace of its own,
 * or is only an office (then withholding is filed at the entity's head office with no workplace).
 */
export type EntityCreate = { entity: LegalEntityInput; registration: CreateRegistrationRequest; headOffice: "SAME_AS_WORKPLACE" | "CREATE_WORKPLACE" | "OFFICE_ONLY" };
export type Plan = { ok: true; body: EntityCreate } | Refused;

/**
 * The structured address: the search result with its codes, or, typed by hand while search was down, the text
 * marked unverified. Nothing is read from the certificate, so `as_printed` stays empty. a hand-typed address
 * takes its province from its first word and its district from the words after it that end in si, gun or gu (the
 * road-name address starts with them), unless the user picked its district from the administrative-district list
 * (then the code and names come from the list).
 */
export const krAddress = (a: AddrDraft): KrAddress => ({
  ...(a.juso ?? { source: "MANUAL_UNVERIFIED" as const, road_addr_part1: a.road, zip_no: a.zip || null, ...(a.district ? picked(a.district) : district(a.road)) }),
  detail: a.detail.trim() || null,
  as_printed: null,
});
const orNull = (s: string) => s.trim() || null;
// Ends in si (city), gun (county) or gu (district).
const DISTRICT_END = /[\uC2DC\uAD70\uAD6C]$/;
function district(road: string) {
  const [si = "", ...rest] = road.trim().split(/\s+/);
  const sgg: string[] = [];
  for (const w of rest) if (sgg.length < 2 && DISTRICT_END.test(w)) sgg.push(w); else break;
  return { si_nm: si, sgg_nm: sgg.join(" ") || null };
}

/** A district picked from the administrative-district list: its code, and its names read from its label. */
function picked(ref: CodeRef) {
  const { si_nm, sgg_nm } = district(ref.label);
  const words = ref.label.trim().split(/\s+/);
  const emd = words.length > 1 + (sgg_nm?.split(" ").length ?? 0) ? words[words.length - 1]! : null;
  return { si_nm, sgg_nm, emd_nm: emd, adm_cd: ref.code };
}

/** Problems and gaps; the server re-validates everything. */
function check(d: Draft, f: Facts): Refused | null {
  const withDocument = Boolean(f.documentId);
  const errors = problems(d, { withDocument, showRequired: true, today: f.today });
  return Object.keys(errors).length > 0 ? { ok: false, errors, missing: missing(d, withDocument) } : null;
}

/** A further certificate of an existing entity (a new workplace's own registration). */
export function planRegistration(d: Draft, f: Facts): { ok: true; body: CreateRegistrationRequest } | Refused {
  return check(d, f) ?? { ok: true, body: registrationOf(d, f.documentId) };
}

export function planEntityCreate(d: Draft, f: Facts): Plan {
  const refused = check(d, f);
  if (refused) return refused;
  const corp = d.bizKind === "CORPORATION";
  const named = d.representatives.map((n) => n.trim()).filter(Boolean);
  const body: EntityCreate = {
    entity: {
      biz_kind: d.bizKind!,
      name: d.name.trim(),
      display_name: d.displayName.trim() || null,
      english_name: d.englishName.trim() || null,
      representatives: named,
      additional_representatives: 0,
      // One representative is a fact, not a choice; more than one was asked.
      representation_mode: representativeCount(d) > 1 ? d.representationMode! : "SINGLE",
      crn: corp ? d.crn : null,
      incorporated_on: d.incorporatedOn || null,
      fiscal_year_end_month: d.fiscalYearEndMonth,
      capital_won: d.capitalWon ? Number(d.capitalWon) : null,
      directors: [],
      main_phone: d.mainPhone ? phoneE164(d.mainPhone) : null,
      main_ksic: d.mainKsic,
      // A corporation's head office is required: this certificate's place, or the one given.
      head_office_address: !corp ? null : krAddress(d.headOffice === "OTHER" ? d.headOfficeAddress! : d.businessAddress!),
    },
    registration: registrationOf(d, f.documentId),
    headOffice: !corp || d.headOffice === "SAME" ? "SAME_AS_WORKPLACE" : d.headOfficeWorkplace!,
  };
  return { ok: true, body };
}

/** The registration as typed; `documentId`: the kept certificate it is typed from, attached as its evidence. */
function registrationOf(d: Draft, documentId?: string): CreateRegistrationRequest {
  return {
    ...(documentId ? { document_id: documentId } : {}),
    ...(d.bizKind === "INDIVIDUAL" ? { trade_name: d.name.trim() } : {}),
    brn: d.brn,
    opened_on: d.openedOn,
    business_address: krAddress(d.businessAddress!),
    business_types: d.businessTypes.map((b, i) => ({ is_main: i === 0, sector: b.sector.trim(), item: b.item.trim(), nts_code: b.ntsCode, ksic: b.ksic })),
    production_factor: orNull(d.productionFactor),
    issue_reason_kind: d.issueReason,
    issue_reason_sub: d.issueReason === "CORRECTION" ? d.correction : null,
    issue_reason_as_printed: d.issueReason === "OTHER_AS_PRINTED" ? orNull(d.issueReasonPrinted) : null,
    co_owners: d.bizKind === "INDIVIDUAL" ? d.coOwners.map((n) => n.trim()).filter(Boolean) : [],
    liquor_license_no: orNull(d.liquorLicenseNo),
    unit_taxation: d.unitTaxation!,
    e_invoice_email: orNull(d.eInvoiceEmail),
    cert_issued_on: d.certIssuedOn || null,
    tax_office_code: d.taxOfficeCode,
    tax_office_label: d.taxOfficePrinted.trim(),
    tax_type: d.taxType!,
  };
}
