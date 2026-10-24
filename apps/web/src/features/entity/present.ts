import type { InfoKey } from "./ui/workplace-edit-fields";
// Copy lookups for the entity slice: problem codes, sections, history changes and the record's values to catalog ids.
import type { LegalEntityState, Revision, WorkplaceKind, BusinessRegistration } from "@console/api/pending";
import { isMessageId, t } from "@console/i18n";
import type { WithholdingTarget } from "@console/api/pending";
import { brnChecksumOff, brnWarnings, kindsOfBrn, type BrnClass, type BrnFacts } from "./domain/brn";
import { BIZ_KIND, labeled, VERIFICATION, codeText, DIRECTOR_ROLE, INSURANCE_STATUS, INSURER, ISSUE_REASON, label, RECORD_STATUS, REPRESENTATION, TAX_TYPE } from "../../lib/labels";
import { fmtDate } from "@console/i18n/format";
import { phoneDisplay } from "../../lib/pure/formats";
import type { CreateProblem } from "./domain/create";
import type { Problem, Section } from "./domain/draft";
import { OWNER } from "./domain/draft";
import { fieldIssues, type CheckAnswer } from "./api";
import { repsAfter, repsMode, type Reps } from "./domain/record-values";
import { kindLabel } from "../../reference/entity/present";

/** A field problem in words, or undefined when there is none. */
export const problemText = (p: Problem | undefined) => (p ? t(`entity.problem.${p}`) : undefined);
export const sectionTitle = (s: Section) => t(`entity.section.${s}`);
/** Whose facts a section holds: the legal entity, this certificate, or both (the first certificate fills both). */
export const sectionOwner = (s: Section) => t(`entity.owner.${OWNER[s]}`);

// A workplace's history interleaves its four social-insurance relations, one chain per insurer: `insurance.<insurer>.<field>`.
const INSURANCE_FIELD = /^insurance\.(NPS|NHIS|EI|IACI)\.(.+)$/;

/** One changed field as read: its name, and enum values (an insurance status) by their labels. */
export function changeLine(c: Revision["changes"][number]) {
  const m = INSURANCE_FIELD.exec(c.field);
  const value = (v: string | null | undefined) => (v == null ? "—" : historyValue(m?.[2] ? `insurance.${m[2]}` : c.field, v));
  const field = m
    ? t("entity.history.insuranceField", { insurer: label(INSURER, m[1]!), field: codeText(`entity.history.field.insurance.${m[2]}`, m[2]!) })
    : (fieldLabel(c.field) ?? c.field);
  return t("entity.history.change", { field, before: value(c.before), after: value(c.after) });
}
const PHONES = new Set(["main_phone", "phone", "fax", "mobile"]);
/**
 * A recorded value as the user typed or chose it (company-24, worst-case-33): enums by their labels, phone numbers in the
 * domestic form (never E.164), dates in Korean; anything else as stored.
 */
export function historyValue(field: string, v: string) {
  const f = field.split(/[[.]/)[0] === "insurance" ? field : field.split(/[[.]/)[0]!;
  if (f === "insurance.status") return label(INSURANCE_STATUS, v);
  if (f === "insurance.unit_mode") return codeText(`entity.history.unitMode.${v}`, v);
  if (f === "representation_mode") return label(REPRESENTATION, v);
  if (f === "status") return label(RECORD_STATUS, v);
  if (f === "issue_reason_kind") return label(ISSUE_REASON, v);
  if (f === "tax_type") return label(TAX_TYPE, v);
  if (f === "vat_unit_mode") return codeText(`entity.vat.${v}`, v);
  if (f === "vat_unit_mode_basis") return codeText(`entity.basis.${v}`, v);
  if (PHONES.has(f)) return phoneDisplay(v);
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? fmtDate(v) : v;
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
  const f = field.split(/[[.]/)[0]!;
  const own = `entityRecord.hf.${f}`;
  const shared = `entity.history.field.${f}`;
  return isMessageId(own) ? t(own) : isMessageId(shared) ? t(shared) : null;
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
  if (registration.nts_check) return checkState(registration.nts_check);
  return registration.verification_tier === "NONE" && registration.unverified_reason === "SERVICE_UNAVAILABLE"
    ? { tone: "neutral" as const, label: t("nts.state.unavailable") }
    : labeled(VERIFICATION, registration.verification_tier);
}

export function checkState(answer?: Partial<CheckAnswer> | null, available = true) {
  if (!available || (answer && !answer.status_code && answer.valid !== "01")) return { tone: "neutral" as const, label: t("nts.state.unavailable") };
  return labeled(VERIFICATION, answer?.valid === "01" ? "T2" : answer?.status_code && !answer.not_registered ? "T1" : "NONE");
}
