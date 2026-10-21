// A plan → the two setup batches the server takes (MR-29 entity-setup for new workplace, MR-12 org-structure for department).
// Pure. New workplace are written first; their ids come back on the entity receipt (by ref) and place the department.
import type { EntitySetupOp, InsurerInput, OrgSetupOp, WithholdingMode } from "@console/api/pending";
import { krAddress, type AddrDraft } from "../../../reference/entity/domain/address";
import type { PlanRoot, PlanRow } from "./plan";

/** The statutory questions a new workplace answers, with no default (S7 paste, R10, R12). */
export type SiteAnswers = {
  /** HEAD: filed with the head office (a corporation's default); OWN: the workplace files its own (independent accounts, Income Tax Act §7①4). */
  withholding: "HEAD" | "OWN" | null;
  /** LATER: established, numbers to come; MAIN: one unit with the main workplace's numbers; NONE: not yet. */
  insurance: "LATER" | "MAIN" | "NONE" | null;
  /** MAIN: the same-legal entity workplace whose numbers it shares. */
  mainWorkplaceId: string | null;
  /** The server still requires these two for a workplace without a registration certificate (contract gap: S7 draws them as to-dos). */
  address: AddrDraft | null;
  openedOn: string;
};
export const emptyAnswers = (): SiteAnswers => ({ withholding: null, insurance: null, mainWorkplaceId: null, address: null, openedOn: "" });
export const answered = (a: SiteAnswers) =>
  a.withholding !== null && a.insurance !== null && (a.insurance !== "MAIN" || a.mainWorkplaceId !== null) && a.address !== null && a.openedOn !== "";
/** How many of the questions are still open (the card's "n to choose"). */
export const openQuestions = (a: SiteAnswers) =>
  [a.withholding !== null, a.insurance !== null && (a.insurance !== "MAIN" || a.mainWorkplaceId !== null), a.address !== null, a.openedOn !== ""].filter((x) => !x).length;

const INSURERS = ["NPS", "NHIS", "EI", "IACI"] as const;
// PART_OF goes as ESTABLISHED_NUMBER_PENDING (an ESTABLISHED row needs its own management number, which a unit that
// shares the main workplace's numbers does not have); revisit when the server takes PART_OF without a status.
const insurance = (a: SiteAnswers): { shortcut: "ALL_ESTABLISHED_NUMBERS_LATER" | "NONE_YET" | "PER_INSURER"; insurers: InsurerInput[] } =>
  a.insurance === "MAIN"
    ? { shortcut: "PER_INSURER", insurers: INSURERS.map((insurer) => ({ insurer, status: "ESTABLISHED_NUMBER_PENDING", unit_mode: "PART_OF", main_workplace_id: a.mainWorkplaceId })) }
    : { shortcut: a.insurance === "LATER" ? "ALL_ESTABLISHED_NUMBERS_LATER" : "NONE_YET", insurers: [] };

/** A new workplace's ref, which also keys its answers; `prefix` keeps several legal entities' plans apart in one batch. */
export const wpRef = (at: number, prefix = "") => `${prefix}wp${at}`;
const unitRef = (at: number, prefix: string) => `${prefix}u${at}`;

/** The new workplace as CREATE_WORKPLACE ops (empty when the root is a workplace or nothing new). `corp`: a corporation files at its head office by statute, so only the exception is sent. */
export function entityOps(root: PlanRoot, rows: PlanRow[], answers: Record<string, SiteAnswers>, corp: boolean, prefix = ""): EntitySetupOp[] {
  if (root.kind !== "entity") return [];
  return rows
    .filter((r) => r.level === "workplace" && r.status === "create")
    .map((r) => {
      const a = answers[wpRef(r.at, prefix)]!;
      const withholding: WithholdingMode | null = a.withholding === "OWN" ? "OWN_INDEPENDENT_ACCOUNTS" : corp ? null : "HEAD_OFFICE";
      return {
        op: "CREATE_WORKPLACE",
        ref: wpRef(r.at, prefix),
        legal_entity_id: root.node.id,
        workplace: { name: r.name, same_address_as_registration: false, address: krAddress(a.address!), opened_on: a.openedOn, withholding_mode: withholding, insurance: insurance(a) },
      };
    });
}

/**
 * The department creates, in row order so a parent comes before its children. `workplaceIds` maps a new workplace's ref
 * (wp<at>) to the id the entity receipt returned.
 */
/** `heads` maps a head employee number (org-06 import) to its employee; the code and head go on the unit's own create. */
export function orgOps(root: PlanRoot, rows: PlanRow[], workplaceIds: Record<string, string>, prefix = "", heads: ReadonlyMap<string, string | null> = new Map()): OrgSetupOp[] {
  const byAt = new Map(rows.map((r) => [r.at, r]));
  return rows
    .filter((r) => r.level === "dept" && r.status === "create")
    .map((r) => {
      const p = r.parent === undefined ? undefined : byAt.get(r.parent);
      const place: Partial<OrgSetupOp> =
        !p ? { workplace_id: root.node.id }
        : p.status === "create" && p.level === "workplace" ? { workplace_id: workplaceIds[wpRef(p.at, prefix)] }
        : p.status === "create" ? { parent_ref: unitRef(p.at, prefix) }
        : p.level === "workplace" ? { workplace_id: p.existing!.id }
        : { parent_org_unit_id: p.existing!.id };
      const head = r.head ? heads.get(r.head) : undefined;
      return { op: "CREATE", ref: unitRef(r.at, prefix), name: r.name, ...place, ...(r.code ? { code: r.code } : {}), ...(head ? { head_employee_id: head } : {}) };
    });
}

/** Whether the plan can be committed: nothing left to fix and every new workplace answered. */
export const ready = (rows: PlanRow[], answers: Record<string, SiteAnswers>, prefix = "") =>
  rows.length > 0 &&
  rows.every((r) => r.status === "link" || r.status === "create") &&
  rows.some((r) => r.status === "create") &&
  rows.filter((r) => r.level === "workplace" && r.status === "create").every((r) => answers[wpRef(r.at, prefix)] && answered(answers[wpRef(r.at, prefix)]!));
