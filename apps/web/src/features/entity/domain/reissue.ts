// certificate reissue (POST /business-registrations/{id}/reissues): a newly issued certificate and the facts it changed,
// recorded as one dated change. What the request carries and from when it holds. Pure.
import type { CorrectionReason, LegalEntity, RegistrationReissue, ReissueReason } from "@console/api/pending";
import { entityRevision, registrationRevision, revProblem, type EntityPatch, type RegistrationPatch } from "./revise";

/** A newly issued certificate: never the one in force for the registration nor one already superseded (the same file dropped again is the same kept document). */
export const isNewCertificate = (doc: { registration_id?: string | null; superseded_at?: string | null }, registrationId: string) =>
  doc.registration_id !== registrationId && !doc.superseded_at;

/** The amendment report first: a reissue with changed facts is the common case. */
export const REISSUE_REASONS: readonly ReissueReason[] = ["CERT_CHANGE_REPORT", "CERT_REISSUE", "CERT_ERROR_CORRECTION"];

/** The certificate's facts a new certificate can change; each is edited by the record page's own field spec. */
export type ItemKey = "name" | "representatives" | "businessAddress" | "headOffice" | "businessTypes" | "coOwners";

/** The correction sub-reason each changed fact prints as (VAT Act Enforcement Decree art. 14(1)); several changes print other. */
const SUB: Record<ItemKey, CorrectionReason> = {
  name: "TRADE_NAME",
  representatives: "REPRESENTATIVE",
  businessAddress: "RELOCATION",
  headOffice: "RELOCATION",
  businessTypes: "INDUSTRY",
  coOwners: "OTHER",
};

/** The printed issue reason the new certificate prints: reissue, or correction with its sub-reason; an error correction keeps what was printed. */
export function printedReason(reason: ReissueReason, changed: readonly ItemKey[]): RegistrationPatch {
  if (reason === "CERT_REISSUE") return { issue_reason_kind: "REISSUE", issue_reason_sub: null, issue_reason_as_printed: null };
  if (reason === "CERT_ERROR_CORRECTION") return {};
  const subs = new Set(changed.map((k) => SUB[k]));
  return { issue_reason_kind: "CORRECTION", issue_reason_sub: subs.size === 1 ? [...subs][0]! : "OTHER", issue_reason_as_printed: null };
}

/**
 * From when the certificate's facts hold: a change from the date it was reported (change date); a reissue changes nothing, so
 * from its issue date (never before the state in force); an error correction rewrites the period in force.
 */
export function reissueFrom(reason: ReissueReason, issued: string, changedOn: string, inForce: string) {
  if (reason === "CERT_ERROR_CORRECTION") return inForce;
  if (reason === "CERT_REISSUE") return issued > inForce ? issued : inForce;
  return changedOn;
}

/** Why the change date cannot be used: after today, or before the certificate state in force (that is an error correction). */
export function fromProblem(reason: ReissueReason, from: string, inForce: string, today: string): "future" | "beforeInForce" | null {
  if (reason !== "CERT_CHANGE_REPORT" || !from) return null;
  if (from > today) return "future";
  return revProblem(from, inForce) === "beforeInForce" ? "beforeInForce" : null;
}

/**
 * When the entity's part starts, or why it cannot be recorded: it is the state in force with the certificate's changes, so a
 * scheduled entity state (which does not carry them) refuses it — recorded, it would be undone from that day on
 * (the server's entity_change_scheduled); a later state already in force moves it to that state's date.
 */
export function entityPartFrom(e: LegalEntity, from: string): { scheduled: string } | { from: string } {
  const scheduled = e.scheduled.map((x) => x.effective_from).sort().at(-1);
  if (scheduled) return { scheduled };
  const inForce = e.current?.effective_from;
  return { from: inForce && inForce > from ? inForce : from };
}

type Picked = { docId: string; reason: ReissueReason; from: string; issued: string; changed: readonly ItemKey[]; reg: RegistrationPatch; entity: EntityPatch };

/**
 * The request: the registration's full state with the changed facts, the new issue date and printed reason; the
 * entity's full state only when the certificate changed something the entity records. Null when a record cannot be read whole.
 */
export function reissueBody(e: LegalEntity, registrationId: string, p: Picked): RegistrationReissue | null {
  const verb = p.reason === "CERT_ERROR_CORRECTION" ? "cor" : "rev";
  const reg = registrationRevision(e, registrationId, { ...p.reg, ...printedReason(p.reason, p.changed), cert_issued_on: p.issued }, verb, p.from);
  if (!reg) return null;
  const { effective_from: _rf, reason_code: _rr, ...registration } = reg;
  const body: RegistrationReissue = { document_id: p.docId, reason: p.reason, effective_from: p.from, registration };
  if (Object.keys(p.entity).length === 0) return body;
  const ent = entityRevision(e, p.entity, verb, p.from);
  if (!ent) return null;
  const { effective_from: _ef, reason_code: _er, ...entity } = ent;
  return { ...body, entity };
}
