// Lifecycle rules: which scheduled actions apply later, can be withdrawn, how history sorts, and which
// HR verbs the employee page offers (the server's lists decide; this only explains what they leave out).
import type { components } from "@console/api/schema";
import { retirementDate } from "./employment";

type LifecycleEvent = components["schemas"]["EmployeeLifecycleEvent"];
type Detail = components["schemas"]["EmployeeDetail"];
type NextEvent = NonNullable<components["schemas"]["Employee"]["next_event"]>;
type Failed = NonNullable<components["schemas"]["Employee"]["failed_event"]>;
/** The HR verbs recorded on the employee page (exits go through an exit case). */
export type Verb = "TRANSFER" | "GROUP_TRANSFER" | "PROMOTE" | "APPOINT" | "EMPLOYMENT_TYPE_CHANGE" | "LEAVE_OF_ABSENCE" | "RETURN_FROM_LEAVE" | "CONTRACT_RENEWAL";
/** The verbs the shared lifecycle sheet records; a group transfer has its own sheet (two legal entities, consent, continuity). */
export type SheetVerb = Exclude<Verb, "GROUP_TRANSFER">;

const DAY = 86_400_000;
const utc = (d: string) => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)));
export const addDays = (d: string, n: number) => new Date(utc(d) + n * DAY).toISOString().slice(0, 10);
export const daysBetween = (from: string, to: string) => Math.round((utc(to) - utc(from)) / DAY);

/** A date after `today` (YYYY-MM-DD, KST) schedules the action for that date instead of applying it now. */
export const isFuture = (date: string, today: string) => /^\d{4}-\d{2}-\d{2}$/.test(date) && date > today;

/** Contracts ending within this many days are flagged (the renewal queue on Home uses the same window). */
export const CONTRACT_SOON_DAYS = 60;

/**
 * A scheduled action can be withdrawn until its date; a scheduled exit is withdrawn through its exit
 * case instead (the server refuses it here).
 */
export const cancellable = (x: LifecycleEvent) => x.state === "SCHEDULED" && x.event_type !== "TERMINATE";

/** Kinds never corrected or rescinded here: an exit goes back through its exit case; a registration, rehire or rescission is not undone. */
const KEPT = new Set<LifecycleEvent["event_type"]>(["TERMINATE", "OFFBOARD", "EXIT_REVERSAL", "ONBOARD", "REHIRE", "RESCIND"]);
/** BW-11: the change in force recorded last (applied, not a rescission, not voided); the server corrects or rescinds only it. */
export const latestInForce = (items: readonly LifecycleEvent[]) =>
  items
    .filter((x) => x.state === "APPLIED" && x.event_type !== "RESCIND" && !x.voided_by)
    .reduce<LifecycleEvent | undefined>((a, x) => (!a || x.created_at > a.created_at || (x.created_at === a.created_at && x.id > a.id) ? x : a), undefined);
/** Whether this record can be corrected  or rescinded : the latest change in force, of a kind the server undoes. */
export const voidable = (x: LifecycleEvent, items: readonly LifecycleEvent[]) => !KEPT.has(x.event_type) && latestInForce(items)?.id === x.id;
export const correctable = (x: LifecycleEvent, items: readonly LifecycleEvent[]) => voidable(x, items) && x.event_type !== "GROUP_TRANSFER";

/** History by effective date, newest first; records of one date by when they were recorded. A back-dated record sits at its date. */
export const byEffective = (items: readonly LifecycleEvent[]) =>
  [...items].sort((a, b) => b.effective_date.localeCompare(a.effective_date) || Date.parse(b.created_at) - Date.parse(a.created_at));

/**
 * The history's two lanes around today: scheduled records (still waiting, whatever their date) above,
 * everything else below. Withdrawn and replaced records stay out unless asked for.
 */
export function lanes(items: readonly LifecycleEvent[], showCancelled: boolean) {
  const sorted = byEffective(items);
  return {
    upcoming: sorted.filter((x) => x.state === "SCHEDULED"),
    past: sorted.filter((x) => x.state !== "SCHEDULED" && (showCancelled || x.state !== "CANCELLED")),
    cancelled: items.filter((x) => x.state === "CANCELLED").length,
  };
}

/** Why a verb the server does not offer is unavailable, from server facts only. */
export type VerbWhy = { kind: "exitScheduled"; date: string } | { kind: "onLeave" } | { kind: "noEmployment" } | { kind: "generic" };
/**
 * A verb on the employee page. Enabled when the server lists it: `min` when it is offered only after the
 * last scheduled record, `max` when it is offered only before it.
 */
export type VerbState = { verb: Verb; enabled: true; min?: string; max?: string; after?: string; before?: string } | { verb: Verb; enabled: false; why: VerbWhy };

const ORDER: Verb[] = ["TRANSFER", "GROUP_TRANSFER", "PROMOTE", "APPOINT", "EMPLOYMENT_TYPE_CHANGE", "LEAVE_OF_ABSENCE", "RETURN_FROM_LEAVE", "CONTRACT_RENEWAL"];
const isVerb = (k: string): k is Verb => (ORDER as string[]).includes(k);

/**
 * The verbs the employee page shows: those relevant to this person (transfer and promotion always, return
 * instead of leave while on leave or with a leave scheduled, renewal for a contract or a missing employment record)
 * plus any the server lists. The server's lists alone decide what is enabled.
 */
export function verbStates(d: Pick<Detail, "employee" | "employment" | "allowed_events" | "allowed_scheduled_events" | "schedule_after">, events: readonly LifecycleEvent[]): VerbState[] {
  const now = new Set(d.allowed_events.map((a) => a.event_type).filter(isVerb));
  const later = new Set(d.allowed_scheduled_events.map((a) => a.event_type).filter(isVerb));
  const scheduled = (type: LifecycleEvent["event_type"]) => events.find((x) => x.state === "SCHEDULED" && x.event_type === type);
  const leave = d.employee.status === "ON_LEAVE" || scheduled("LEAVE_OF_ABSENCE") !== undefined;
  const relevant = new Set<Verb>(["TRANSFER", "GROUP_TRANSFER", "PROMOTE", leave ? "RETURN_FROM_LEAVE" : "LEAVE_OF_ABSENCE"]);
  if (!d.employment || d.employment.employment_type === "CONTRACT") relevant.add("CONTRACT_RENEWAL");
  const exit = scheduled("TERMINATE");
  const after = d.schedule_after ?? undefined;
  return ORDER.filter((v) => relevant.has(v) || now.has(v) || later.has(v)).map((verb): VerbState => {
    if (now.has(verb) && later.has(verb)) return { verb, enabled: true };
    if (now.has(verb)) return after ? { verb, enabled: true, max: addDays(after, -1), before: after } : { verb, enabled: true };
    if (later.has(verb) && after) return { verb, enabled: true, min: addDays(after, 1), after };
    const why: VerbWhy =
      exit ? { kind: "exitScheduled", date: retirementDate(exit.effective_date) }
      : d.employee.status === "ON_LEAVE" && (verb === "TRANSFER" || verb === "GROUP_TRANSFER" || verb === "PROMOTE") ? { kind: "onLeave" }
      : verb === "CONTRACT_RENEWAL" && !d.employment ? { kind: "noEmployment" }
      : { kind: "generic" };
    return { verb, enabled: false, why };
  });
}

/** Years and whole months from `from` to `to` (both YYYY-MM-DD); null when `from` is later. */
export function tenure(from: string, to: string): { years: number; months: number } | null {
  if (from > to) return null;
  let months = (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + Number(to.slice(5, 7)) - Number(from.slice(5, 7));
  if (to.slice(8) < from.slice(8)) months--;
  return { years: Math.floor(months / 12), months: months % 12 };
}

/** One line of the "next" box: what is due next for this person, from the record and its history. */
export type NextItem =
  | { kind: "failed"; event: Failed }
  | { kind: "event"; event: NextEvent }
  | { kind: "contract"; date: string; days: number }
  | { kind: "return"; date: string | null };

/**
 * The next box, ordered by date (an open return date last): a failed record not yet redone, the nearest
 * scheduled record, the contract end, and while on leave the expected return from the leave in effect.
 */
export function nextItems(employee: Detail["employee"], employment: Detail["employment"], events: readonly LifecycleEvent[], today: string): NextItem[] {
  const items: NextItem[] = [];
  if (employee.failed_event) items.push({ kind: "failed", event: employee.failed_event });
  if (employee.next_event) items.push({ kind: "event", event: employee.next_event });
  const end = employment?.contract_end_date ?? employee.contract_end_date;
  if (end && employee.status !== "EXITED") items.push({ kind: "contract", date: end, days: daysBetween(today, end) });
  if (employee.status === "ON_LEAVE") {
    const leave = byEffective(events).find((x) => x.event_type === "LEAVE_OF_ABSENCE" && x.state === "APPLIED");
    items.push({ kind: "return", date: leave?.expected_return_date ?? null });
  }
  const date = (i: NextItem) => (i.kind === "failed" || i.kind === "event" ? i.event.effective_date : i.date) ?? "9999-12-31";
  return items.sort((a, b) => date(a).localeCompare(date(b)));
}

/**
 * The unit a record named, as an id: only when exactly one active unit has that name (records keep the
 * name, not the id; a dissolved or ambiguous unit is left for the user to pick).
 */
export const unitByName = (name: string | null | undefined, units: readonly { id: string; name: string; status: string }[]) => {
  const hits = units.filter((u) => u.status === "ACTIVE" && u.name === name);
  return hits.length === 1 ? hits[0]!.id : null;
};
