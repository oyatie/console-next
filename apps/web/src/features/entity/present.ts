import type { InfoKey } from "./ui/workplace-edit-fields";
// Copy lookups for the entity slice: problem codes, sections, history changes and the record's values to catalog ids.
import type { LegalEntityState, Revision, WorkplaceKind, BusinessRegistration } from "@console/api/pending";
import { isMessageId, t } from "@console/i18n";
import type { WithholdingTarget } from "@console/api/pending";
import { brnChecksumOff, brnWarnings, kindsOfBrn, type BrnClass, type BrnFacts } from "./domain/brn";
import { BIZ_KIND, CORRECTION, INSURANCE_STATUS, ISSUE_REASON, RECORD_STATUS, TAX_TYPE, type Enum, labeled, VERIFICATION, codeText, DIRECTOR_ROLE, INSURER, label, REPRESENTATION } from "../../lib/labels";
import { fmtDate } from "@console/i18n/format";
import { phoneDisplay } from "../../lib/pure/formats";
import type { CreateProblem } from "./domain/create";
import type { Problem, Section } from "./domain/draft";
import { OWNER } from "./domain/draft";
import { fieldIssues, type CheckAnswer } from "./api";
import { repsAfter, repsMode, type Reps } from "./domain/record-values";
import { kindLabel } from "../../reference/entity/present";

type HistoryField = { kind: "bool" | "date" | "phone" | "text" | "reference" | "directors" | "enum"; enum?: Enum; prefix?: string };
/** Checked against the served revised-state schemas by history-schema.test.ts. */
export const HISTORY_FIELDS: Readonly<Record<string, HistoryField>> = {
  "english_name": { kind: "text" },
  "name": { kind: "text" },
  "display_name": { kind: "text" },
  "representation_mode": { kind: "enum", enum: REPRESENTATION },
  "representatives": { kind: "text" },
  "additional_representatives": { kind: "text" },
  "head_office_address": { kind: "text" },
  "incorporated_on": { kind: "date" },
  "fiscal_year_end_month": { kind: "text" },
  "capital_won": { kind: "text" },
  "directors": { kind: "directors" },
  "vat_unit_mode": { kind: "enum", prefix: "entity.vat" },
  "vat_unit_mode_basis": { kind: "enum", prefix: "entity.basis" },
  "main_ksic_code": { kind: "text" },
  "main_ksic_label": { kind: "text" },
  "main_ksic_version": { kind: "text" },
  "main_phone": { kind: "phone" },
  "priority_support": { kind: "enum", prefix: "entityHistoryField.prioritySupport" },
  "priority_support_basis": { kind: "enum", prefix: "entityHistoryField.prioritySupportBasis" },
  "large_group_member": { kind: "bool" },
  "classification_reason": { kind: "text" },
  "trade_name": { kind: "text" },
  "opened_on": { kind: "date" },
  "business_address": { kind: "text" },
  "business_types": { kind: "text" },
  "unit_taxation": { kind: "bool" },
  "tax_type": { kind: "enum", enum: TAX_TYPE },
  "tax_office_code": { kind: "text" },
  "tax_office_label": { kind: "text" },
  "issue_reason_kind": { kind: "enum", enum: ISSUE_REASON },
  "issue_reason_sub": { kind: "enum", enum: CORRECTION },
  "issue_reason_as_printed": { kind: "text" },
  "cert_issued_on": { kind: "date" },
  "e_invoice_email": { kind: "text" },
  "liquor_license_no": { kind: "text" },
  "production_factor": { kind: "text" },
  "co_owners": { kind: "text" },
  "status": { kind: "enum", enum: RECORD_STATUS },
  "status_since": { kind: "date" },
  "status_until": { kind: "date" },
  "address": { kind: "text" },
  "mail_address": { kind: "text" },
  "representative_name": { kind: "text" },
  "main_product": { kind: "text" },
  "phone": { kind: "phone" },
  "fax": { kind: "phone" },
  "mobile": { kind: "phone" },
  "email": { kind: "text" },
  "is_construction_site": { kind: "bool" },
  "is_abstract": { kind: "bool" },
  "not_registered_reason": { kind: "text" },
  "withholding_mode": { kind: "enum", prefix: "entityHistoryField.withholding" },
  "bulk_filed_on": { kind: "date" },
  "independent_lsa_unit": { kind: "bool" },
  "independent_lsa_evidence": { kind: "text" },
  "insurance.status": { kind: "enum", enum: INSURANCE_STATUS },
  "insurance.mgmt_no": { kind: "text" },
  "insurance.established_on": { kind: "date" },
  "insurance.unit_mode": { kind: "enum", prefix: "entityHistoryField.unitMode" },
  "insurance.main_workplace_id": { kind: "reference" },
  "insurance.nps_separate_application": { kind: "bool" },
  "insurance.nhis_unit_workplace_code": { kind: "text" },
  "insurance.nhis_branch_office_code": { kind: "text" },
  "insurance.nhis_workplace_class": { kind: "enum", prefix: "entityHistoryField.nhisWorkplaceClass" },
  "insurance.iaci_business_type_code": { kind: "text" },
  "insurance.iaci_business_type_label": { kind: "text" },
  "insurance.iaci_insurance_year": { kind: "text" },
  "insurance.iaci_business_form": { kind: "enum", prefix: "entityHistoryField.iaciBusinessForm" },
  "insurance.iaci_term_from": { kind: "date" },
  "insurance.iaci_term_to": { kind: "date" },
  "insurance.prime_contractor_mgmt_no": { kind: "text" },
  "biz_kind": { kind: "enum", enum: BIZ_KIND },
  "crn": { kind: "text" },
  "brn": { kind: "text" },
  "sub_serial": { kind: "text" },
  "registration_id": { kind: "text" },
  "same_address_as_registration": { kind: "bool" },
  "reg_mode": { kind: "enum", prefix: "entityHistoryField.regMode" },
  "effective_from": { kind: "text" },
  "reason_code": { kind: "text" },
  "not_registered_reason_code": { kind: "reference" },
  "not_registered_reason_label": { kind: "text" },
  "not_registered_reason_list_key": { kind: "reference" },
  "not_registered_reason_version": { kind: "reference" },
};

/** A field problem in words, or undefined when there is none. */
export const problemText = (p: Problem | undefined) => (p ? t(`entity.problem.${p}`) : undefined);
export const sectionTitle = (s: Section) => t(`entity.section.${s}`);
/** Whose facts a section holds: the legal entity, this certificate, or both (the first certificate fills both). */
export const sectionOwner = (s: Section) => t(`entity.owner.${OWNER[s]}`);

// A workplace's history interleaves its four social-insurance relations, one chain per insurer: `insurance.<insurer>.<field>`.
const INSURANCE_FIELD = /^insurance\.(NPS|NHIS|EI|IACI)\.(.+)$/;

/** One changed field as read: its name, and enum values (an insurance status) by their labels. */
export function changeLine(c: Revision["changes"][number]) {
  if (c.field === "registration_id") return t("entityHistoryField.registration.changed");
  const m = INSURANCE_FIELD.exec(c.field);
  const value = (v: string | null | undefined) => (v == null ? "—" : historyValue(m?.[2] ? `insurance.${m[2]}` : c.field, v));
  const field = m
    ? t("entity.history.insuranceField", { insurer: label(INSURER, m[1]!), field: fieldLabel(`insurance.${m[2]}`) ?? t("entity.refusal.field") })
    : (fieldLabel(c.field) ?? t("entity.refusal.field"));
  return t("entity.history.change", { field, before: value(c.before), after: value(c.after) });
}
/** The same boolean value words apply to every boolean field definition. */
const booleanText = (v: string) => v === "true" || v === "false" ? t(`entityHistoryField.bool.${v}`) : v;

/** Typed history values use the field definition; free text stays as recorded. */
export function historyValue(field: string, v: string) {
  const f = field.replace(/^insurance\.(?:NPS|NHIS|EI|IACI)\./, "insurance.").split("[")[0]!;
  const definition = Object.hasOwn(HISTORY_FIELDS, f) ? HISTORY_FIELDS[f] : undefined;
  switch (definition?.kind) {
    case "bool": return booleanText(v);
    case "date": return Number.isNaN(Date.parse(v)) ? v : fmtDate(v);
    case "phone": return phoneDisplay(v);
    case "reference": return t("entityHistoryField.reference.changed");
    case "enum": return definition.enum ? label(definition.enum, v) : codeText(`${definition.prefix}.${v}`, v);
    // shortcut: flattened names are ambiguous; use structured directors when history provides them.
    case "directors": return v.replace(/(^|, )([A-Z_]+)(?= )/g, (_, prefix: string, role: string) => prefix + label(DIRECTOR_ROLE, role))
      .replace(/ (\d{4}-\d{2}-\d{2})(?=, |$)/g, (_, d: string) => ` ${Number.isNaN(Date.parse(d)) ? d : fmtDate(d)}`);
    default: return v;
  }
}
/** A create refusal in words, or nothing. */
export const problem = (p: CreateProblem | undefined) => (p ? t(`entityCreate.problem.${p}`) : undefined);
/** The representatives as one line, with how several represent. */
export const repsText = (r: Reps) => {
  const mode = repsMode(r);
  return `${repsAfter(r).join(", ")}${mode ? ` (${label(REPRESENTATION, mode)})` : ""}`;
};
type Director = NonNullable<LegalEntityState["directors"]>[number];
/** Officers as one line: role and name, in printed order. */
export const directorsText = (ds: readonly Pick<Director, "role" | "name">[]) =>
  // company-26: a row whose role is not chosen yet reads as its name alone, never "null <name>".
  ds.filter((d) => d.name.trim()).map((d) => [d.role ? label(DIRECTOR_ROLE, d.role) : "", d.name].filter(Boolean).join(" ")).join(", ") || "—";

export { kindLabel, kindName } from "../../reference/entity/present";
const fold = (s: string) => s.normalize("NFC").trim().toLocaleLowerCase();
/**
 * Whether `label` is already a kind's label as shown, a default's catalog label included: the server sees only the
 * tenant's own labels, so a new label equal to the default STORE label is refused here (ENT-KIND MR-19).
 */
export const kindTaken = (kinds: readonly WorkplaceKind[], name: string, except?: string) =>
  kinds.some((k) => k.code !== except && fold(kindLabel(k)) === fold(name));

/** A recorded field's name in words (`business_types[0].sector` names business_types), or null when the catalogs have none. */
export function fieldLabel(field: string) {
  const f = field.startsWith("insurance.") ? field.replace(/^insurance\.(?:NPS|NHIS|EI|IACI)\./, "insurance.") : field.split(/[[.]/)[0]!;
  const history = `entityHistoryField.${f}`;
  if (isMessageId(history)) return t(history);
  const aliases = {
    priority_support: "entityRecord.vat.priority",
    biz_kind: "entity.field.bizKind",
    main_ksic_label: "entityRecord.vat.mainKsic",
    co_owners: "entity.field.coOwners",
    sub_serial: "workplace.field.subSerial",
  } as const;
  if (Object.hasOwn(aliases, f)) return t(aliases[f as keyof typeof aliases]);
  const own = `entityRecord.hf.${f}`;
  const shared = `entity.history.field.${f}`;
  const extra = `entityHistoryField.${f}`;
  return isMessageId(own) ? t(own) : isMessageId(shared) ? t(shared) : isMessageId(extra) ? t(extra) : null;
}

/**
 * A refused entity command's own words, for CommandError's `own`: each refused field named with its reason (the
 * server's message for a 422 is only generic), or the sentence for an entity refusal code (`entity.refused.*`).
 */
export const fieldRefusal = (error: unknown) => (code: string) => {
  const issues = fieldIssues(error);
  // A refusal without field errors: the entity's own words for its code (the server's Korean for an untranslated one
  // is only the generic sentence), else the shared copy.
  if (code !== "validation_failed" || issues.length === 0) return codeText(`entity.refused.${code}`, "") || undefined;
  return issues
    .map((i) => t("entity.refusal.line", { field: fieldLabel(i.field) ?? t("entity.refusal.field"), reason: codeText(`entity.refusal.${i.code}`, t("entity.refusal.other")) }))
    .join(" · ");
};

// --- lane: UX-R1 ENTITY (operations copy) ---
/**
 * The head office files for the entity under Income Tax Act s7(1)3; a branch files for itself only with independent accounts (s7(1)4). A head office
 * that is its own unit is therefore never called independent accounts: that word is only for the s7(1)4 case.
 */
export function withholdingText(w: WithholdingTarget) {
  if (w.kind === "UNDECIDED") return t("workplace.withholding.undecided");
  if (w.kind !== "SELF_UNIT") return t("orgStructure.wp.whHead");
  return w.basis === "income_tax_act_7_1_4" ? t("orgStructure.wp.whOwn") : t("entityOps.withholding.headSelf");
}

/** The soft signals the number and dates give (company-37), as one line, or undefined. */
export function brnWarningText(d: BrnFacts, classes: readonly BrnClass[] = []) {
  const w = brnWarnings(d, classes);
  const kinds = kindsOfBrn(d.brn, classes);
  const lines = [
    d.brnConfirmed === d.brn && brnChecksumOff(d.brn) && t("entityOps.brn.confirmed"),
    w.includes("kindMismatch") && kinds.length && t("entityOps.brn.kindMismatch", { mid: d.brn.slice(3, 5), kind: kinds.map((kind) => label(BIZ_KIND, kind)).join(", ") }),
  ].filter(Boolean);
  return lines.length ? lines.join(" ") : undefined;
}

/** A corporation's opening date before its incorporation date (company-37), in words, or undefined. */
export const openedWarningText = (d: BrnFacts) => (brnWarnings(d).includes("openedBeforeIncorporated") ? t("entityOps.brn.openedBeforeIncorporated") : undefined);

/** Why a revision was recorded, in words, for the reason codes these operations write (company-19); else undefined. */
export function reasonText(code: string | null | undefined) {
  if (!code) return undefined;
  const id = `entityOps.reason.${code.startsWith("SUSPENSION_") ? "SUSPENSION" : code}`;
  return isMessageId(id) ? t("entityOps.reason.line", { reason: t(id) }) : undefined;
}

/** Each fact's label, as its row and its sheet name it. */
export const INFO_LABEL: Record<InfoKey, () => string> = {
  name: () => t("workplace.field.name"),
  representative: () => t("workplace.field.representative"),
  product: () => t("entityOps.info.product"),
  phone: () => t("workplace.field.phone"),
  fax: () => t("entityOps.info.fax"),
  email: () => t("workplace.field.email"),
  mail: () => t("entityOps.info.mail"),
  openedOn: () => t("workplace.field.openedOn"),
};


export function verificationState(registration: BusinessRegistration) {
  if (registration.verification_tier !== "NONE") return labeled(VERIFICATION, registration.verification_tier);
  if (registration.nts_check) return checkState(registration.nts_check);
  return registration.verification_tier === "NONE" && registration.unverified_reason === "SERVICE_UNAVAILABLE"
    ? { tone: "neutral" as const, label: t("nts.state.unavailable") }
    : labeled(VERIFICATION, registration.verification_tier);
}

export function checkState(answer?: Partial<CheckAnswer> | null, available = true) {
  if (!available || (answer && !answer.status_code && answer.valid !== "01")) return { tone: "neutral" as const, label: t("nts.state.unavailable") };
  return labeled(VERIFICATION, answer?.valid === "01" ? "T2" : answer?.status_code && !answer.not_registered ? "T1" : "NONE");
}
