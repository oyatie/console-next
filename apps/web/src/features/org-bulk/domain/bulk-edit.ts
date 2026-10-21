// Workplace bulk edit (S7): one social insurance state for several workplaces, row by row with what changes and
// what stays (an insurer already established is not set back). Pure.
import type { InsurerInput, InsuranceRelation, InsuranceStatus } from "@console/api/pending";

/** LATER: established, numbers to come; NONE: not established yet. */
export type InsuranceState = "LATER" | "NONE";
export type EditRow = { id: string; name: string; entity: string; insurance: InsuranceRelation[] };
export type EditLine = EditRow & { change: boolean; before: InsuranceStatus | "MIXED" | "EMPTY"; insurers: InsurerInput[]; expectedVersion: number };

const INSURERS = ["NPS", "NHIS", "EI", "IACI"] as const;
const TARGET: Record<InsuranceState, InsuranceStatus> = { LATER: "ESTABLISHED_NUMBER_PENDING", NONE: "NOT_ESTABLISHED" };
/** A status already at or past the target stays: an established insurer is never moved back to "numbers later". */
const settled = (s: InsuranceStatus | undefined, target: InsuranceStatus) =>
  s === target || (target === "ESTABLISHED_NUMBER_PENDING" && s === "ESTABLISHED");

/**
 * A row changes only when none of its insurers is already at or past the target; a row with some insurers settled
 * stays as it is (its numbers are never re-sent from a read), and the sheet says so.
 */
export function editLines(rows: EditRow[], state: InsuranceState): EditLine[] {
  const target = TARGET[state];
  return rows.map((r) => {
    const statuses = [...new Set(INSURERS.map((i) => r.insurance.find((x) => x.insurer === i)?.status))];
    const before = statuses.length === 1 ? (statuses[0] ?? "EMPTY") : "MIXED";
    const change = statuses.every((s) => !settled(s, target));
    return {
      ...r,
      before,
      change,
      insurers: change ? INSURERS.map((insurer) => ({ insurer, status: target })) : [],
      expectedVersion: Math.max(0, ...r.insurance.map((x) => x.version)),
    };
  });
}
