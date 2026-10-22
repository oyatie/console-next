// Adding a entity (S4): the quick two-input save and the certificate wizard. Pure: the draft and what the tenant
// already holds in, the request bodies or the reasons they cannot be sent out. Empty items never refuse; they
// stay on the box as to-dos. Only a typed value that cannot be right refuses (spec S4 "R"), and the CRN check
// digit only warns ("W").
import type { BizKind, LegalEntity, LegalEntityInput, RegistrationInput } from "@console/api/pending";
import { CORP_CHECK_DIGIT_UNTIL, corpRegNoChecksumOk, FORMATS, phoneE164, validEmail } from "../../../lib/pure/formats";
import type { Draft } from "./draft";
import { brnChecksumOff, brnWarnings, brnNeedsLook, type BrnClass } from "./brn";
import { krAddress } from "./plan";
import { entityName, latinName, personName } from "../../../reference/entity/domain/names";

export type WizardStep = "basics" | "certificate" | "registry" | "review";
/** A corporation also types its registry extract (registry and representatives); the others go straight to the review. */
export const stepsFor = (k: BizKind | null, founding = false): WizardStep[] =>
  k === "CORPORATION" ? (founding ? ["basics", "registry", "review"] : ["basics", "certificate", "registry", "review"]) : ["basics", "certificate", "review"];
/** Being founded applies to a corporation only (company-08). */
export const isFounding = (d: Pick<Draft, "bizKind" | "founding">) => d.bizKind === "CORPORATION" && d.founding;

/** Refusals shown as typed: each names the certificate item to look at again. */
export type CreateProblem = "brnLength" | "brnTaken" | "brnChecksum" | "crnLength" | "future" | "emailInvalid" | "phoneInvalid" | "issuedBeforeOpened";
export type CreateField = "brn" | "crn" | "openedOn" | "eInvoiceEmail" | "mainPhone" | "certIssuedOn" | "incorporatedOn";
/** Where a number is already recorded: the entity and the workplace that holds that certificate. */
export type Taken = { entityId: string; entity: string; holder: string | null };

const blank = (s: string) => s.trim() === "";

/** The open registration of this tenant that already carries `brn`, if any (spec S4: a duplicate refuses). */
export function takenBrn(brn: string, entities: readonly LegalEntity[]): Taken | null {
  if (brn.length !== FORMATS.bizRegNo.max) return null;
  for (const e of entities) {
    if (e.closed_on) continue;
    const r = e.registrations.find((x) => !x.closed_on && x.brn?.value === brn);
    if (!r) continue;
    const holder = e.workplaces.find((w) => w.id === r.holder_workplace_id)?.current?.name ?? null;
    return { entityId: e.id, entity: entityName(e), holder };
  }
  return null;
}

/** The typed values that refuse. Empty values are never problems here. */
export function createProblems(d: Draft, f: { today: string; taken: Taken | null }): Partial<Record<CreateField, CreateProblem>> {
  const out: Partial<Record<CreateField, CreateProblem>> = {};
  if (d.brn && d.brn.length !== FORMATS.bizRegNo.max) out.brn = "brnLength";
  else if (f.taken) out.brn = "brnTaken";
  // worst-case-25: a wrong check digit holds the number for a second look (never a silent ✓).
  else if (brnNeedsLook(d)) out.brn = "brnChecksum";
  if (d.crn && d.crn.length !== FORMATS.corpRegNo.max) out.crn = "crnLength";
  if (d.openedOn > f.today) out.openedOn = "future";
  if (d.incorporatedOn > f.today) out.incorporatedOn = "future";
  if (d.certIssuedOn && d.certIssuedOn > f.today) out.certIssuedOn = "future";
  else if (d.certIssuedOn && d.openedOn && d.certIssuedOn < d.openedOn) out.certIssuedOn = "issuedBeforeOpened";
  if (d.eInvoiceEmail && !validEmail(d.eInvoiceEmail)) out.eInvoiceEmail = "emailInvalid";
  if (d.mainPhone && !phoneE164(d.mainPhone)) out.mainPhone = "phoneInvalid";
  return out;
}

/**
 * The CRN's check digit does not match (annex 4). Numbers issued from 2025-01-31 carry none, so it only warns,
 * and only while the incorporation date is unknown or before that date.
 */
export const crnWarns = (d: Draft) =>
  d.crn.length === FORMATS.corpRegNo.max && (!d.incorporatedOn || d.incorporatedOn < CORP_CHECK_DIGIT_UNTIL) && !corpRegNoChecksumOk(d.crn);

/** Every value the server needs to record the certificate itself (RegistrationInput's required set). */
export const registrationReady = (d: Draft) =>
  d.brn.length === FORMATS.bizRegNo.max && !blank(d.name) && d.openedOn !== "" && d.businessAddress !== null &&
  d.businessTypes.length > 0 && d.businessTypes.every((b) => !blank(b.sector) && !blank(b.item)) &&
  d.unitTaxation !== null && d.taxType !== null && !blank(d.taxOfficePrinted);

/**
 * What the server takes before it records a entity at all: a named representative, and for a corporation its CRN
 * and a head office address (legal_entity validation). Spec S4 wants kind + name only, a backend gap (CS-BE).
 */
export type EntityGap = "kind" | "name" | "representatives" | "crn" | "headOffice" | "representationMode";
export function entityGaps(d: Draft): EntityGap[] {
  const gaps: EntityGap[] = [];
  if (!d.bizKind) gaps.push("kind");
  if (blank(d.name)) gaps.push("name");
  // The server records no entity without a named representative (legal_entity validation).
  if (namedReps(d).length === 0) gaps.push("representatives");
  // More than one named representative: how they represent is asked, never assumed.
  if (namedReps(d).length > 1 && !d.representationMode) gaps.push("representationMode");
  if (d.bizKind === "CORPORATION") {
    // A corporation being founded has no number until its incorporation registry (company-08).
    if (!isFounding(d) && d.crn.length !== FORMATS.corpRegNo.max) gaps.push("crn");
    if (!headOfficeAddress(d)) gaps.push("headOffice");
  }
  return gaps;
}
const namedReps = (d: Draft) => d.representatives.map((n) => n.trim()).filter(Boolean);
const headOfficeAddress = (d: Draft) => (d.headOffice === "SAME" ? d.businessAddress : d.headOfficeAddress);

/** The quick sheet shares this refusal between its save controls and command guard. */
export function quickBlock(d: Draft) {
  if (personName(d.name, d.representatives)) return "entity.refusal.legal_name_is_person";
  if (d.displayName.trim() && personName(d.displayName.trim(), d.representatives)) return "entity.refusal.display_name_is_person";
  if (d.englishName.trim() && !latinName(d.englishName.trim())) return "entity.refusal.english_name_not_latin";
  if (d.englishName.trim() && personName(d.englishName.trim(), d.representatives)) return "entity.refusal.english_name_is_person";
  if (!d.bizKind || !d.name.trim() || !d.representatives.some((n) => n.trim())) return "entityQuick.hold.basics";
  return entityGaps(d).length ? "entityQuick.hold.corp" : null;
}

/** The entity as the server records it from whatever the draft holds (call only once `entityGaps` is empty). */
export function entityBody(d: Draft): LegalEntityInput {
  const corp = d.bizKind === "CORPORATION";
  const reps = namedReps(d);
  const head = headOfficeAddress(d);
  const directors = d.directors.filter((x) => x.role && !blank(x.name)).map((x) => ({ role: x.role!, name: x.name.trim(), appointed_on: x.appointedOn || null }));
  return {
    biz_kind: d.bizKind!,
    name: d.name.trim(),
    display_name: d.displayName.trim() || null,
    english_name: d.englishName.trim() || null,
    representatives: reps,
    additional_representatives: 0,
    // One named representative (or none yet) is a fact; more than one was asked (entityGaps).
    representation_mode: reps.length > 1 ? d.representationMode! : "SINGLE",
    crn: corp && !isFounding(d) ? d.crn : null,
    founding: isFounding(d),
    // company-21: with no incorporation date, the record starts at the certificate's opening date, not today.
    opened_on: d.openedOn || null,
    head_office_address: corp && head ? krAddress(head) : null,
    incorporated_on: corp ? d.incorporatedOn || null : null,
    fiscal_year_end_month: corp ? d.fiscalYearEndMonth : null,
    capital_won: corp && d.capitalWon ? Number(d.capitalWon) : null,
    directors: corp ? directors : [],
    main_phone: d.mainPhone ? phoneE164(d.mainPhone) : null,
    main_ksic: d.mainKsic,
  };
}

/** The certificate, or null while a value it needs is still empty (the box then reads "no certificate"). */
export function registrationBody(d: Draft): RegistrationInput | null {
  if (isFounding(d) || !registrationReady(d)) return null;
  return {
    ...(d.bizKind === "INDIVIDUAL" ? { trade_name: d.name.trim() } : {}),
    brn: d.brn,
    classification_reason: d.classificationReason.trim() || null,
    opened_on: d.openedOn,
    business_address: krAddress(d.businessAddress!),
    business_types: d.businessTypes.map((b, i) => ({ is_main: i === 0, sector: b.sector.trim(), item: b.item.trim(), nts_code: b.ntsCode, ksic: b.ksic })),
    production_factor: d.productionFactor.trim() || null,
    issue_reason_kind: d.issueReason,
    issue_reason_sub: d.issueReason === "CORRECTION" ? d.correction : null,
    issue_reason_as_printed: d.issueReason === "OTHER_AS_PRINTED" ? d.issueReasonPrinted.trim() || null : null,
    co_owners: d.bizKind === "INDIVIDUAL" ? d.coOwners.map((n) => n.trim()).filter(Boolean) : [],
    liquor_license_no: d.liquorLicenseNo.trim() || null,
    unit_taxation: d.unitTaxation!,
    e_invoice_email: d.eInvoiceEmail.trim() || null,
    cert_issued_on: d.certIssuedOn || null,
    tax_office_code: d.taxOfficeCode,
    tax_office_label: d.taxOfficePrinted.trim(),
    tax_type: d.taxType!,
  };
}

/** One certificate item in the side checklist, in the certificate's own order and numbering. */
export type ItemState = "ok" | "err" | "warn" | "todo" | "na";
export type ItemKey = "taxType" | "brn" | "name" | "representatives" | "openedOn" | "crn" | "businessAddress" | "headOffice" | "businessTypes" | "issueReason" | "liquorLicenseNo" | "unitTaxation" | "eInvoiceEmail" | "issued";
export type CertItem = { key: ItemKey; no?: number; state: ItemState };

/** The checklist for a corporation's certificate (14 items: 11 numbered, plus taxpayer type, registration number and issue date and tax office). */
export function corpItems(d: Draft, p: Partial<Record<CreateField, CreateProblem>>, classes: readonly BrnClass[] = []): CertItem[] {
  const has = (ok: boolean): ItemState => (ok ? "ok" : "todo");
  return [
    { key: "taxType", state: has(d.taxType !== null) },
    { key: "brn", state: p.brn ? "err" : brnChecksumOff(d.brn) || brnWarnings(d, classes).includes("kindMismatch") ? "warn" : has(d.brn !== "") },
    { key: "name", no: 1, state: has(!blank(d.name)) },
    { key: "representatives", no: 2, state: has(d.representatives.some((n) => !blank(n))) },
    { key: "openedOn", no: 3, state: p.openedOn ? "err" : brnWarnings(d).includes("openedBeforeIncorporated") ? "warn" : has(d.openedOn !== "") },
    { key: "crn", no: 4, state: p.crn ? "err" : crnWarns(d) ? "warn" : has(d.crn !== "") },
    { key: "businessAddress", no: 5, state: has(d.businessAddress !== null) },
    { key: "headOffice", no: 6, state: has(headOfficeAddress(d) !== null) },
    { key: "businessTypes", no: 7, state: has(d.businessTypes.every((b) => !blank(b.sector) && !blank(b.item))) },
    { key: "issueReason", no: 8, state: has(d.issueReason !== null) },
    { key: "liquorLicenseNo", no: 9, state: blank(d.liquorLicenseNo) ? "na" : "ok" },
    { key: "unitTaxation", no: 10, state: has(d.unitTaxation !== null) },
    { key: "eInvoiceEmail", no: 11, state: p.eInvoiceEmail ? "err" : has(!blank(d.eInvoiceEmail)) },
    { key: "issued", state: p.certIssuedOn ? "err" : has(d.certIssuedOn !== "" && !blank(d.taxOfficePrinted)) },
  ];
}

/** Items entered (an item with nothing to enter counts as done) out of all. */
export const itemsDone = (items: readonly CertItem[]) => items.filter((i) => i.state === "ok" || i.state === "na" || i.state === "warn").length;
