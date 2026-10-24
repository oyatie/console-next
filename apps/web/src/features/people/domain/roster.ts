import { retirementDate } from "./employment";
// The roster's rules: which filters the URL holds and the server query they make, how the status chips
// add up from server totals, the one "next" item a row shows, tenure, and the exact employee-number jump.
import type { components } from "@console/api/schema";
import { scopeQuery } from "./scope";

type Employee = components["schemas"]["Employee"];
type Detail = components["schemas"]["EmployeeDetail"];
export type Status = "ACTIVE" | "ON_LEAVE" | "UNKNOWN" | "EXITED" | "PRE_HIRE";
type EventType = NonNullable<Employee["next_event"]>["event_type"];

const DAY = 86_400_000;
const utc = (d: string) => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)));
export const addDays = (d: string, n: number) => new Date(utc(d) + n * DAY).toISOString().slice(0, 10);
export const daysBetween = (from: string, to: string) => Math.round((utc(to) - utc(from)) / DAY);

/**
 * The status views, one at a time. `current` (the default, nothing in the URL) is everyone but exited people, starting soon
 * included as rows, apart from the employed population counted by the chart.
 */
export const STATUS_VIEWS = ["current", "ACTIVE", "ON_LEAVE", "PRE_HIRE", "UNKNOWN", "EXITED", "all"] as const;
export type StatusView = (typeof STATUS_VIEWS)[number];
export const STATUSES: Status[] = ["ACTIVE", "ON_LEAVE", "UNKNOWN", "EXITED", "PRE_HIRE"];
export const CURRENT: Status[] = ["ACTIVE", "ON_LEAVE", "UNKNOWN", "PRE_HIRE"];
export const parseStatus = (s?: string): StatusView => STATUS_VIEWS.find((v) => v === s) ?? "current";
export const statusesOf = (v: StatusView): Status[] | undefined => (v === "all" ? undefined : v === "current" ? CURRENT : [v]);

/**
 * The "needs attention" chips: each toggles on its own and they combine with AND, as the server's filters do.
 * The two contract chips are one server filter (`contract_ending_before`), so at most one of them is on.
 */
export const REVIEWS = ["contractPast", "contractSoon", "identity", "branch", "register", "failed"] as const;
export type Review = (typeof REVIEWS)[number];
const isContract = (r: Review) => r === "contractPast" || r === "contractSoon";
/** The URL value ("identity,failed") as chips; unknown tokens are dropped, a second contract chip too. */
export function parseReview(s?: string): Review[] {
  const on = REVIEWS.filter((r) => s?.split(",").includes(r));
  return on.filter((r, i) => !isContract(r) || on.findIndex(isContract) === i);
}
export const joinReview = (on: readonly Review[]) => (on.length ? REVIEWS.filter((r) => on.includes(r)).join(",") : undefined);
export const toggleReview = (on: readonly Review[], r: Review): Review[] =>
  on.includes(r) ? on.filter((x) => x !== r) : [...on.filter((x) => !(isContract(x) && isContract(r))), r];

/** The list's order (GET /employees `sort`); the server's own default is by name. */
export const SORTS = ["org_unit", "name", "employee_number", "hire_date"] as const;
export type RosterSort = (typeof SORTS)[number];
export const parseSort = (v?: string): RosterSort => SORTS.find((x) => x === v) ?? "name";

export type RosterFilter = { status: StatusView; review: readonly Review[]; unit?: string; q?: string; sort?: RosterSort };

/** What the review chips ask the server; `soonDays` is the renewal window Home's queue uses. */
const reviewQuery = (on: readonly Review[], today: string, soonDays: number) => ({
  identity_review_required: on.includes("identity") || undefined,
  home_branch_review_required: on.includes("branch") || undefined,
  register_review_required: on.includes("register") || undefined,
  lifecycle_apply_failed: on.includes("failed") || undefined,
  // Strictly before the date: today finds contracts already over, today + window + 1 every one ending within it.
  contract_ending_before: on.includes("contractPast") ? today : on.includes("contractSoon") ? addDays(today, soonDays + 1) : undefined,
});

/** The list's server query (without paging). */
export const listQuery = (f: RosterFilter, today: string, soonDays: number) => ({
  search: f.q || undefined,
  sort: f.sort && f.sort !== "name" ? f.sort : undefined,
  ...scopeQuery(f.unit),
  status: statusesOf(f.status),
  ...reviewQuery(f.review, today, soonDays),
});

type Facets = components["schemas"]["EmployeeFacets"];

/**
 * The chips' two facet reads. `list` is the list's own filter: its status counts ignore the status filter and carry
 * the rest (unit, search, review chips), and its total is the list's. `review` is the status filter with the renewal
 * window: review counts ignore the review and contract filters, so one read counts every review chip.
 */
export function facetQueries(f: RosterFilter, today: string, soonDays: number) {
  const base = { search: f.q || undefined, ...scopeQuery(f.unit), status: statusesOf(f.status) };
  return { list: { ...base, ...reviewQuery(f.review, today, soonDays) }, review: { ...base, contract_ending_before: addDays(today, soonDays + 1) } };
}
/** The per-status counts (STATUSES order) of a facets read; a status the server did not list counts 0. */
export const statusCounts = (rows?: Facets["status"]) => STATUSES.map((s) => (rows ? (rows.find((r) => r.value === s)?.count ?? 0) : undefined));
/** The review counts in REVIEWS order; contracts ending in the window still include those already over (reviewTotals). */
export const reviewCounts = (r?: Facets["review"]) =>
  r ? [r.contract_ended, r.contract_ending_before ?? undefined, r.identity_review_required, r.home_branch_review_required, r.register_review_required, r.lifecycle_apply_failed] : REVIEWS.map(() => undefined);

/** Status chip totals from the per-status server totals; a chip whose inputs are missing is unknown. */
export function statusTotals(n: readonly (number | undefined)[]): Record<StatusView, number | undefined> {
  const [a, l, u, e, p] = n;
  const sum = (xs: (number | undefined)[]) => (xs.every((x) => x !== undefined) ? xs.reduce<number>((s, x) => s + x!, 0) : undefined);
  return { current: sum([a, l, u, p]), ACTIVE: a, ON_LEAVE: l, PRE_HIRE: p, UNKNOWN: u, EXITED: e, all: sum([a, l, u, e, p]) };
}

/**
 * Review chip totals. "Ending within the window" counts the window minus those already over, though the server
 * filter for it lists both (it has only a strictly-before bound); the chip's description says so.
 */
export function reviewTotals(n: readonly (number | undefined)[]): Record<Review, number | undefined> {
  const [past, soon, identity, branch, register, failed] = n;
  return { contractPast: past, contractSoon: soon === undefined || past === undefined ? undefined : soon - past, identity, branch, register, failed };
}

export type NextItem =
  | { kind: "failed"; event: EventType; date: string }
  | { kind: "event"; event: EventType; date: string; days: number }
  | { kind: "contract"; date: string; days: number }
  | { kind: "return"; date: string; days: number };

/**
 * What comes next for a person, most urgent first: an action that failed to apply, the nearest scheduled
 * action, then a contract ending within `soonDays` (or already over) while still employed; while on leave, the
 * expected return the leave named (unless the return is already scheduled, which is the next action).
 */
export function nextItems(e: Employee, today: string, soonDays: number): NextItem[] {
  const items: NextItem[] = [];
  if (e.failed_event) items.push({ kind: "failed", event: e.failed_event.event_type, date: e.failed_event.effective_date });
  if (e.next_event) items.push({ kind: "event", event: e.next_event.event_type, date: e.next_event.effective_date, days: daysBetween(today, e.next_event.effective_date) });
  const end = e.contract_end_date;
  if (end && e.status !== "EXITED" && daysBetween(today, end) <= soonDays) items.push({ kind: "contract", date: end, days: daysBetween(today, end) });
  const back = e.status === "ON_LEAVE" ? e.expected_return_date : undefined;
  if (back && e.next_event?.event_type !== "RETURN_FROM_LEAVE") items.push({ kind: "return", date: back, days: daysBetween(today, back) });
  return items;
}

/** Whole years and months since the hire date; null before it (not yet started) or without one. */
export function tenure(hire: string | null | undefined, today: string): { years: number; months: number } | null {
  if (!hire || hire > today) return null;
  let months = (Number(today.slice(0, 4)) - Number(hire.slice(0, 4))) * 12 + Number(today.slice(5, 7)) - Number(hire.slice(5, 7));
  if (Number(today.slice(8, 10)) < Number(hire.slice(8, 10))) months -= 1;
  return { years: Math.floor(months / 12), months: months % 12 };
}

/** The chart's employed population; people starting soon are listed apart. */
export const headcount = (t: Record<StatusView, number | undefined>) => (t.ACTIVE === undefined || t.ON_LEAVE === undefined || t.UNKNOWN === undefined ? undefined : t.ACTIVE + t.ON_LEAVE + t.UNKNOWN);

/**
 * The one person whose employee number is exactly the typed text (trimmed, any case), else null: Enter then
 * opens that person instead of filtering. Numbers take any shape (E-000001, HK-4112, 0042), so none is assumed.
 */
export function exactNumber(rows: readonly Employee[], text: string): Employee | null {
  const want = text.trim().toLowerCase();
  const hits = want ? rows.filter((e) => e.employee_number?.toLowerCase() === want) : [];
  return hits.length === 1 ? hits[0]! : null;
}

type Verb = Exclude<Detail["allowed_events"][number]["event_type"], "ONBOARD">;
const VERBS = ["TRANSFER", "PROMOTE", "LEAVE_OF_ABSENCE", "RETURN_FROM_LEAVE", "CONTRACT_RENEWAL"] as const satisfies readonly Verb[];
/**
 * The actions the server accepts for a person now or after their last scheduled one, in the record's order. Only
 * what the server lists (both lists are empty for a reader without manage); why another is not offered is the
 * record's to say.
 */
export const offeredVerbs = (d: Pick<Detail, "allowed_events" | "allowed_scheduled_events">) =>
  VERBS.filter((v) => [...d.allowed_events, ...d.allowed_scheduled_events].some((a) => a.event_type === v));

/** A built-in view: a status and review chips, one press (spec E1 view tabs; saved views are not served yet). */
export type View = { id: "current" | "preHire" | "contractSoon" | "gaps"; status?: StatusView; review?: Review[] };
export const VIEWS: View[] = [
  { id: "current", status: "current", review: [] },
  { id: "preHire", status: "PRE_HIRE", review: [] },
  { id: "contractSoon", status: "current", review: ["contractSoon"] },
  { id: "gaps", status: "current", review: ["register"] },
];


/** Retention of an exited person's register (Labor Standards Act §42, Decree §22): 3 years from the exit date (the day after the last working day). */
export const RETENTION_YEARS = 3;
export function retentionEnd(lastDay: string): string {
  const exit = retirementDate(lastDay);
  return `${Number(exit.slice(0, 4)) + RETENTION_YEARS}${exit.slice(4)}`;
}
