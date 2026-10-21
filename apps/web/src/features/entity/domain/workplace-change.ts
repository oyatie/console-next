// A workplace's dated changes beyond its contacts (pure): move (catalog company-12) and suspension · resumption (company-07), as the
// full-state revision the server records. The people and filings they touch are named on screen; the trail is LIFECYCLE's.
import type { KrAddress, WorkplaceInput } from "@console/api/pending";

/** Why a suspension (VAT Act Enforcement Decree s13 suspension reasons), chosen from a list; the printed reason goes with the revision. */
export const SUSPEND_REASONS = ["SLOWDOWN", "SEASONAL", "WORKS", "OTHER"] as const;
export type SuspendReason = (typeof SUSPEND_REASONS)[number];

/** suspension from `since` (expected to end `until`, optional), or resumption from `since`. */
export type StatusDraft = { since: string; until: string; reason: SuspendReason | null };
export type StatusProblem = "required" | "future" | "untilBeforeSince" | "beforeCurrent";

/** What holds a suspension or resumption back: no start, a start before the status it follows, an end before the start. */
export function statusProblems(d: StatusDraft, suspend: boolean, f: { today: string; from?: string | null }): Partial<Record<keyof StatusDraft, StatusProblem>> {
  const out: Partial<Record<keyof StatusDraft, StatusProblem>> = {};
  if (!d.since) out.since = "required";
  // The status is a confirmed fact: it starts no later than today (the server refuses a future status_since).
  else if (d.since > f.today) out.since = "future";
  else if (f.from && d.since < f.from) out.since = "beforeCurrent";
  if (suspend && !d.reason) out.reason = "required";
  if (suspend && d.until && d.since && d.until < d.since) out.until = "untilBeforeSince";
  return out;
}

/** The revision a suspension (or a resumption, when `suspend` is false) sends: the same state, its status from the chosen day. */
export function statusChange(base: WorkplaceInput, d: StatusDraft, suspend: boolean) {
  return suspend
    ? { ...base, status: "SUSPENDED" as const, status_since: d.since, status_until: d.until || null, effective_from: d.since, reason_code: `SUSPENSION_${d.reason}` }
    : { ...base, status: "CONTINUING" as const, status_since: null, status_until: null, effective_from: d.since, reason_code: "RESUMPTION" };
}

/**
 * move (a dated move from `on`) or an address typed wrong from the start (a correction from when the current one began). The
 * workplace then keeps its own address: its certificate's address changes only by the certificate's own correction.
 */
export function moveChange(base: WorkplaceInput, address: KrAddress, mode: "MOVE" | "CORRECTION", on: string, currentFrom: string) {
  return {
    ...base,
    same_address_as_registration: false,
    address,
    effective_from: mode === "MOVE" ? on : currentFrom,
    reason_code: mode === "MOVE" ? "RELOCATION" : "CORRECTION",
  };
}
