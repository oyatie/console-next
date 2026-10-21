// Home's work queue: which lane an item sits in. Pure rules over the server's records; the server
// still enforces every step, and these lanes only decide where an item is shown.
import type { components } from "@console/api/schema";

type Change = components["schemas"]["OrgChangeSummary"];

/** The lanes (H1+ hr-home): mine to act on now, someone else's turn, and dated items not yet due. */
export const LANES = ["turn", "waiting", "scheduled"] as const;
export type Lane = (typeof LANES)[number];
/** Views of my turn: everything, deadlines, requests addressed to me, and failures. */
export const VIEWS = ["all", "deadlines", "requests", "failures"] as const;
export type View = (typeof VIEWS)[number];

const DAY = 86_400_000;
/** A YYYY-MM-DD calendar date `days` later. */
export const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
/** Whole calendar days from `today` to `date` (both YYYY-MM-DD); negative once `date` has passed. */
export const daysUntil = (date: string, today: string) => Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY);

/** The org changes on Home, by where each one sits. */
export type ChangeLanes = {
  /** The drafter's own changes needing the drafter: edit a draft, read a rejection, settle. */
  mine: Change[];
  /** Approved and on or past their date: effectuating is this caller's turn. */
  due: Change[];
  /** The drafter's own changes now on someone else's turn (in approval, or due for another apply holder). */
  waiting: Change[];
  /** Approved, dated after today. */
  scheduled: Change[];
};

/**
 * Sorts the caller's changes (`own`: drafted by `me`, every status, so a redraft settles its rejection whatever
 * became of it) and every approved change an apply holder sees (`approved`) into lanes. A change in both lists
 * counts once. Dated lanes run earliest first.
 */
export function changeLanes(own: readonly Change[], approved: readonly Change[], opts: { me?: string; canApply: boolean; today: string }): ChangeLanes {
  const lanes: ChangeLanes = { mine: [], due: [], waiting: [], scheduled: [] };
  const seen = new Set<string>();
  // A rejection is mine to act on until I redraft it: the redraft names it (`supersedesId`, org/present awaitingRedraft).
  const redrafted = new Set(own.map((c) => c.supersedesId));
  for (const c of [...own, ...approved]) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    const drafter = c.draftedBy === opts.me;
    if (c.status === "APPROVED") {
      if (c.effectiveDate > opts.today) lanes.scheduled.push(c);
      else if (opts.canApply) lanes.due.push(c);
      else if (drafter) lanes.waiting.push(c);
    } else if (drafter && c.status === "IN_APPROVAL") lanes.waiting.push(c);
    else if (drafter && (c.status === "DRAFT" || c.status === "PRECHECKED" || c.status === "SETTLING")) lanes.mine.push(c);
    else if (drafter && c.status === "REJECTED" && !redrafted.has(c.id)) lanes.mine.push(c);
  }
  const byDate = (a: Change, b: Change) => a.effectiveDate.localeCompare(b.effectiveDate);
  lanes.due.sort(byDate);
  lanes.scheduled.sort(byDate);
  return lanes;
}
