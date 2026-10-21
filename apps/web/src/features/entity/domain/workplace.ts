// Planner for adding a workplace to a legal entity (design §3.4, challenge A-4, A-5, A-6, A-8). Pure.
import type { CodeRef, CreateWorkplaceRequest, InsuranceShortcut, InsurerInput, Insurer, InsuranceStatus } from "@console/api/pending";
import { FORMATS, phoneE164 } from "../../../lib/pure/formats";
import { validEmail, type AddrDraft } from "./draft";
import { krAddress } from "./plan";

export const INSURERS: readonly Insurer[] = ["NPS", "NHIS", "EI", "IACI"];
/**
 * The setup shortcut for all four insurers, with no default (challenge A-8): established with numbers to come
 * (a to-do, no clock), established with numbers now, not yet, or different per insurer.
 */
export const INSURANCE_CHOICES: readonly InsuranceShortcut[] = ["ALL_ESTABLISHED_NUMBERS_LATER", "ALL_ESTABLISHED_NOW", "NONE_YET", "PER_INSURER"];
/** `code`: the NHIS branch office, picked from the insurance-branch list (NHIS rows only). */
export type InsuranceRow = { insurer: Insurer; status: InsuranceStatus | null; mgmtNo: string; establishedOn: string; code?: CodeRef | null };
/**
 * How the workplace is registered for VAT: its own new certificate, a certificate already entered for this entity
 * that no workplace holds yet (the first certificate), a sub-workplace of a unit-taxation registration, or later.
 */
export type RegMode = "NEW" | "EXISTING" | "UNIT_TAXATION_SUB" | "NOT_REQUIRED" | "LATER";

export type WorkplaceDraft = {
  name: string;
  regMode: RegMode | null;
  /** EXISTING: which of the entity's unheld certificates. */
  registrationId: string | null;
  subSerial: string;
  notRegisteredReason: CodeRef | null;
  isAbstract: boolean;
  address: AddrDraft | null;
  openedOn: string;
  phone: string;
  email: string;
  /** Files its own withholding tax (a corporation's branch with independent accounts, Income Tax Act s7(1)4), or at the head office. */
  independentAccounts: boolean | null;
  /** The head office (a corporation) or main place of business (an individual), asked only when neither decided nor evident. */
  headOffice: boolean | null;
  insurance: InsuranceShortcut | null;
  rows: InsuranceRow[];
};
export const emptyWorkplace = (): WorkplaceDraft => ({
  name: "", regMode: null, registrationId: null, subSerial: "", notRegisteredReason: null, isAbstract: false, address: null, openedOn: "", phone: "", email: "", independentAccounts: null, headOffice: null, insurance: null,
  rows: INSURERS.map((insurer) => ({ insurer, status: null, mgmtNo: "", establishedOn: "" })),
});

export type WpKey = keyof WorkplaceDraft | `row.${Insurer}.status` | `row.${Insurer}.mgmtNo` | `row.${Insurer}.establishedOn`;
export type WpProblem = "required" | "insuranceNoLength" | "subSerial" | "emailInvalid" | "phoneInvalid";
/** What the screen knows: whether the head office question applies (the entity's head office is not settled). */
export type WpFacts = { askHeadOffice: boolean; showRequired: boolean };

export const abstractFromReason = (reason?: { isAbstract?: boolean }) => reason?.isAbstract ?? false;

/** The insurance rows the choice stands for: the shortcut fills statuses; numbers are typed where needed. */
export function rowsFor(d: Pick<WorkplaceDraft, "insurance" | "rows">): InsuranceRow[] {
  const all = (status: InsuranceStatus) => d.rows.map((r) => ({ ...r, status }));
  return d.insurance === "ALL_ESTABLISHED_NUMBERS_LATER" ? all("ESTABLISHED_NUMBER_PENDING") : d.insurance === "ALL_ESTABLISHED_NOW" ? all("ESTABLISHED") : d.insurance === "NONE_YET" ? all("NOT_ESTABLISHED") : d.rows;
}

/** Insurance problems only (the edit sheet reuses them). */
export function insuranceProblems(d: Pick<WorkplaceDraft, "insurance" | "rows">, showRequired: boolean): Partial<Record<WpKey, WpProblem>> {
  const out: Partial<Record<WpKey, WpProblem>> = {};
  const need = (k: WpKey, ok: boolean) => {
    if (!ok && showRequired) out[k] = "required";
  };
  need("insurance", d.insurance !== null);
  for (const r of rowsFor(d)) {
    if (d.insurance === "PER_INSURER") need(`row.${r.insurer}.status`, r.status !== null);
    if (r.status === "ESTABLISHED") {
      need(`row.${r.insurer}.mgmtNo`, r.mgmtNo !== "");
      need(`row.${r.insurer}.establishedOn`, r.establishedOn !== "");
      if (r.mgmtNo && (r.mgmtNo.length < FORMATS.insuranceNo.min || r.mgmtNo.length > FORMATS.insuranceNo.max)) out[`row.${r.insurer}.mgmtNo`] = "insuranceNoLength";
    }
  }
  return out;
}

export function workplaceProblems(d: WorkplaceDraft, f: WpFacts): Partial<Record<WpKey, WpProblem>> {
  const out: Partial<Record<WpKey, WpProblem>> = insuranceProblems(d, f.showRequired);
  const need = (k: WpKey, ok: boolean) => {
    if (!ok && f.showRequired) out[k] = "required";
  };
  need("name", d.name.trim() !== "");
  need("regMode", d.regMode !== null);
  if (d.regMode === "EXISTING") need("registrationId", d.registrationId !== null);
  if (d.regMode === "UNIT_TAXATION_SUB") {
    need("subSerial", d.subSerial !== "");
    if (d.subSerial && (d.subSerial.length !== FORMATS.subSerial.max || d.subSerial === "0000")) out.subSerial = "subSerial";
  }
  if (d.regMode === "NOT_REQUIRED") {
    need("notRegisteredReason", d.notRegisteredReason !== null);
  }
  // A certificate of its own brings the address and opening date; otherwise they are asked here.
  // An abstract workplace has no address.
  const abstract = d.regMode === "NOT_REQUIRED" && d.isAbstract;
  if ((d.regMode === "UNIT_TAXATION_SUB" || d.regMode === "LATER" || d.regMode === "NOT_REQUIRED") && !abstract) {
    need("address", d.address !== null);
  }
  if (d.regMode === "UNIT_TAXATION_SUB" || d.regMode === "LATER" || d.regMode === "NOT_REQUIRED") {
    need("openedOn", d.openedOn !== "");
  }
  need("independentAccounts", d.independentAccounts !== null);
  if (f.askHeadOffice) need("headOffice", d.headOffice !== null);
  if (d.email && !validEmail(d.email)) out.email = "emailInvalid";
  if (d.phone && !phoneE164(d.phone)) out.phone = "phoneInvalid";
  return out;
}

/** The four relations as the server takes them: statuses come from the shortcut unless chosen per insurer. */
export const insurers = (d: Pick<WorkplaceDraft, "insurance" | "rows">): InsurerInput[] =>
  d.insurance === "ALL_ESTABLISHED_NUMBERS_LATER" || d.insurance === "NONE_YET"
    ? []
    : rowsFor(d).map((r) => ({
        insurer: r.insurer,
        status: d.insurance === "PER_INSURER" ? r.status! : undefined,
        mgmt_no: r.status === "ESTABLISHED" ? r.mgmtNo : null,
        established_on: r.status === "ESTABLISHED" ? r.establishedOn : null,
        ...rowCode(r),
      }));

const rowCode = (r: InsuranceRow): Partial<InsurerInput> => (r.code && r.insurer === "NHIS" ? { nhis_branch_office_code: r.code.code } : {});

/**
 * The create request, once `workplaceProblems` is empty. `registrationId`: the certificate this workplace holds
 * (NEW: the one just added; EXISTING: the one chosen) or the unit-taxation one it is a sub-workplace of.
 * `openedOn`: the certificate's opening date when the workplace takes its place from it.
 */
export function planWorkplace(d: WorkplaceDraft, f: { corp: boolean; registrationId: string | null; openedOn?: string; headOffice: boolean | null }): CreateWorkplaceRequest {
  const own = d.regMode === "NEW" || d.regMode === "EXISTING";
  const notReq = d.regMode === "NOT_REQUIRED";
  const abstract = notReq && d.isAbstract;
  return {
    name: d.name.trim(),
    registration_id: d.regMode === "LATER" || notReq ? null : f.registrationId,
    sub_serial: d.regMode === "UNIT_TAXATION_SUB" ? d.subSerial : null,
    reg_mode: d.regMode ?? undefined,
    not_registered_reason: notReq && d.notRegisteredReason ? { code: d.notRegisteredReason.code, version: d.notRegisteredReason.version } : null,
    is_abstract: abstract,
    same_address_as_registration: own,
    address: own || abstract || !d.address ? null : krAddress(d.address),
    opened_on: own ? f.openedOn! : d.openedOn,
    phone: d.phone ? phoneE164(d.phone) : null,
    email: d.email.trim() || null,
    // A corporation files at its head office by statute (s7(1)3), so only the exception is sent; anyone else says where.
    withholding_mode: d.independentAccounts ? "OWN_INDEPENDENT_ACCOUNTS" : f.corp ? null : "HEAD_OFFICE",
    is_head_office: f.headOffice,
    insurance: { shortcut: d.insurance!, insurers: insurers(d) },
  };
}
