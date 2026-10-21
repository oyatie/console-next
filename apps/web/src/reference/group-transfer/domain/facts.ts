// A group transfer's own facts (decision #30), wherever one is recorded (the employee card, a workplace close): the employee's
// consent and what carries over, dimension by dimension (design T2), none preselected. Pure.
import type { components } from "@console/api/schema";

type FactsBody = components["schemas"]["GroupTransferFacts"];

/** Severance or annual leave: settled by the sending legal entity, or carried to the receiving one. */
export type Settle = "SETTLED" | "CARRIED";
/** Service: counted afresh from the group transfer, or carried from the group start date. */
export type Seniority = "RESTART" | "CARRIED";

export type GroupFacts = {
  severance: Settle | null;
  annualLeave: Settle | null;
  seniority: Seniority | null;
  consentDate: string;
  consentRef: string;
  successionRef: string;
  groupStart: string;
};

export const EMPTY_FACTS: GroupFacts = { severance: null, annualLeave: null, seniority: null, consentDate: "", consentRef: "", successionRef: "", groupStart: "" };

/** Any carried dimension rests on the succession agreement. */
export const carriesAny = (v: Pick<GroupFacts, "severance" | "annualLeave" | "seniority">) =>
  v.severance === "CARRIED" || v.annualLeave === "CARRIED" || v.seniority === "CARRIED";

/**
 * Each still-missing fact against the group transfer's `date` ("" until picked): the consent (its evidence, and its date on or before
 * the group transfer, Civil Act Art. 657(1)), each continuity dimension, the succession agreement when any is carried, and the group
 * start date (on or before the group transfer).
 */
export function factsMissing(v: GroupFacts, date: string) {
  const after = (d: string) => Boolean(date) && d > date;
  return {
    consentRef: !v.consentRef.trim(),
    consentDate: !v.consentDate || after(v.consentDate),
    severance: !v.severance,
    annualLeave: !v.annualLeave,
    seniority: !v.seniority,
    successionRef: carriesAny(v) && !v.successionRef.trim(),
    groupStart: !v.groupStart || after(v.groupStart),
  };
}

/** The facts as sent, once every dimension is chosen: the succession agreement only when something is carried. */
export const factsBody = (v: GroupFacts): FactsBody | undefined =>
  v.severance && v.annualLeave && v.seniority
    ? {
        continuity: v.severance,
        annual_leave_continuity: v.annualLeave,
        seniority_continuity: v.seniority,
        group_service_start_date: v.groupStart,
        consent_date: v.consentDate,
        consent_evidence_ref: v.consentRef.trim(),
        succession_evidence_ref: carriesAny(v) ? v.successionRef.trim() : undefined,
      }
    : undefined;
