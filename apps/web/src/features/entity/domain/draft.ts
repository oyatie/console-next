// The register sheet's draft of a legal entity and its first business registration (design §3.2, §3.3, as
// amended by the challenge). Pure: values as typed, codes for problems; the view adds copy. The server
// re-validates everything; these rules only tell the user early.
import type { BizKind, CodeRef, CorrectionReason, DirectorRole, IssueReasonKind, KrAddress, NtsTaxType, RepresentationMode } from "@console/api/pending";
import { FORMATS, phoneE164, validEmail } from "../../../lib/pure/formats";
import { brnNeedsLook } from "./brn";

export { validEmail };

/**
 * An address as the address field holds it. `verified` false: typed by hand while search was down. `juso`: the
 * search result it came from, with its codes, so the server stores the structured address and not the text.
 */
export type AddrDraft = { key?: string; road: string; jibun?: string; zip: string; detail: string; verified: boolean; juso?: KrAddress; district?: CodeRef | null };
export type BusinessTypeDraft = { sector: string; item: string; ntsCode: string | null; ksic: CodeRef | null };
/** One officer as the registry extract prints it (Commercial Act s317(2)8): role, name and appointment date. */
export type DirectorDraft = { role: DirectorRole | null; name: string; appointedOn: string };

export type Draft = {
  /** "registration": a further certificate of an existing entity; the entity's own facts are not asked again. */
  scope: "entity" | "registration";
  bizKind: BizKind | null;
  brn: string;
  /** being founded (company-08): a corporation recorded before its incorporation registry, with no corporate registration number and no certificate yet. */
  founding: boolean;
  /** The registration number the user confirmed is printed as typed despite its check digit (worst-case-25). */
  brnConfirmed: string;
  /** The corporate or trade name as printed (item 1); for a corporation the trade name is the same text. */
  name: string;
  /** Names as printed, in order. */
  representatives: string[];
  representationMode: RepresentationMode | null;
  openedOn: string;
  crn: string;
  incorporatedOn: string;
  businessAddress: AddrDraft | null;
  /** The head office is the workplace's own address, or elsewhere (a branch's certificate). */
  headOffice: "SAME" | "OTHER" | null;
  headOfficeAddress: AddrDraft | null;
  headOfficeWorkplace: "CREATE_WORKPLACE" | "OFFICE_ONLY" | null;
  businessTypes: BusinessTypeDraft[];
  productionFactor: string;
  taxType: NtsTaxType | null;
  issueReason: IssueReasonKind | null;
  correction: CorrectionReason | null;
  /** The issue reason as printed, typed when it is none of the listed ones. */
  issueReasonPrinted: string;
  certIssuedOn: string;
  taxOfficePrinted: string;
  taxOfficeCode: string | null;
  coOwners: string[];
  liquorLicenseNo: string;
  unitTaxation: boolean | null;
  eInvoiceEmail: string;
  capitalWon: string;
  fiscalYearEndMonth: number | null;
  mainPhone: string;
  /** The main industry as a KSIC code (design §3, the entity's main industry), picked from the loaded list. */
  mainKsic: CodeRef | null;
  /** The short label shown on the chart where the legal name is long (optional). */
  displayName: string;
  englishName: string;
  classificationReason: string;
  directors: DirectorDraft[];
};

export const emptyDraft = (scope: Draft["scope"] = "entity"): Draft => ({
  scope, bizKind: null, founding: false, brn: "", brnConfirmed: "", name: "", representatives: [""], representationMode: null, openedOn: "", crn: "", incorporatedOn: "",
  businessAddress: null, headOffice: null, headOfficeAddress: null, headOfficeWorkplace: null,
  businessTypes: [{ sector: "", item: "", ntsCode: null, ksic: null }], productionFactor: "", taxType: null, issueReason: null, correction: null,
  issueReasonPrinted: "", certIssuedOn: "", taxOfficePrinted: "", taxOfficeCode: null, coOwners: [], liquorLicenseNo: "", unitTaxation: null,
  eInvoiceEmail: "", capitalWon: "", fiscalYearEndMonth: null, mainPhone: "", mainKsic: null, displayName: "", englishName: "", classificationReason: "", directors: [],
});

/** The sheet's sections, in certificate order; each says whose facts it holds. */
export const SECTIONS = ["identity", "address", "business", "certificate", "registry"] as const;
export type Section = (typeof SECTIONS)[number];
export const OWNER: Record<Section, "entity" | "certificate" | "both"> = { identity: "both", address: "both", business: "certificate", certificate: "certificate", registry: "entity" };

export type FieldKey = keyof Draft | "representatives.0";
export type Problem = "required" | "brnLength" | "brnChecksum" | "crnLength" | "emailInvalid" | "phoneInvalid" | "unitTaxationMismatch" | "issuedBeforeOpened" | "future";

const corp = (d: Draft) => d.bizKind === "CORPORATION";
const own = (d: Draft) => d.scope === "entity";
const blank = (s: string) => s.trim() === "";
/** Named representatives: more than one asks how they represent. */
export const representativeCount = (d: Draft) => d.representatives.filter((n) => !blank(n)).length;

/** Required fields per section, given the facts chosen so far (a corporation needs more). */
function required(d: Draft, withDocument: boolean): Record<Section, [FieldKey, boolean][]> {
  return {
    identity: [
      ...(own(d) ? ([["bizKind", d.bizKind !== null]] as [FieldKey, boolean][]) : []),
      ["brn", d.brn.length > 0],
      ["name", !blank(d.name)],
      // The representatives are the entity's: a further certificate does not ask (or send) them again.
      ...(own(d) ? ([["representatives.0", !blank(d.representatives[0] ?? "")]] as [FieldKey, boolean][]) : []),
      ["openedOn", d.openedOn !== ""],
      ...(own(d) && corp(d) ? ([["crn", d.crn.length > 0]] as [FieldKey, boolean][]) : []),
      ...(own(d) && representativeCount(d) > 1 ? ([["representationMode", d.representationMode !== null]] as [FieldKey, boolean][]) : []),
    ],
    address: [
      ["businessAddress", d.businessAddress !== null],
      ...(own(d) && corp(d) ? ([["headOffice", d.headOffice !== null]] as [FieldKey, boolean][]) : []),
      ...(own(d) && corp(d) && d.headOffice === "OTHER" ? ([["headOfficeAddress", d.headOfficeAddress !== null], ["headOfficeWorkplace", d.headOfficeWorkplace !== null]] as [FieldKey, boolean][]) : []),
    ],
    business: [["businessTypes", d.businessTypes.length > 0 && d.businessTypes.every((b) => !blank(b.sector) && !blank(b.item))]],
    certificate: [
      ["taxType", d.taxType !== null],
      ["unitTaxation", d.unitTaxation !== null],
      ["taxOfficePrinted", !blank(d.taxOfficePrinted)],
      ...(withDocument ? ([["issueReason", d.issueReason !== null], ["certIssuedOn", d.certIssuedOn !== ""]] as [FieldKey, boolean][]) : []),
      ...(d.issueReason === "OTHER_AS_PRINTED" ? ([["issueReasonPrinted", !blank(d.issueReasonPrinted)]] as [FieldKey, boolean][]) : []),
    ],
    registry: [],
  };
}

/** Required values still empty, per section (a collapsed section shows its count). */
export function missing(d: Draft, withDocument: boolean): Record<Section, number> {
  const r = required(d, withDocument);
  return Object.fromEntries(SECTIONS.map((s) => [s, r[s].filter(([, ok]) => !ok).length])) as Record<Section, number>;
}

/** Field problems: required-and-empty (only once `showRequired`), and format or cross-field problems always. */
export function problems(d: Draft, opts: { withDocument: boolean; showRequired: boolean; today: string }): Partial<Record<FieldKey, Problem>> {
  const out: Partial<Record<FieldKey, Problem>> = {};
  if (opts.showRequired) for (const s of SECTIONS) for (const [k, ok] of required(d, opts.withDocument)[s]) if (!ok) out[k] = "required";
  if (d.brn && d.brn.length !== FORMATS.bizRegNo.max) out.brn = "brnLength";
  else if (brnNeedsLook(d)) out.brn = "brnChecksum";
  if (d.crn && d.crn.length !== FORMATS.corpRegNo.max) out.crn = "crnLength";
  if (d.eInvoiceEmail && !validEmail(d.eInvoiceEmail)) out.eInvoiceEmail = "emailInvalid";
  if (d.mainPhone && !phoneE164(d.mainPhone)) out.mainPhone = "phoneInvalid";
  if (d.openedOn > opts.today) out.openedOn = "future";
  if (d.certIssuedOn && d.openedOn && d.certIssuedOn < d.openedOn) out.certIssuedOn = "issuedBeforeOpened";
  return out;
}
