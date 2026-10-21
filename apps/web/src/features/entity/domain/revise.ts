// Changing a recorded fact of an entity or its certificate (spec S3, decision #21): change (REV) (REV, the fact changed
// from a date on; the earlier period keeps the old value) or correction (COR) (COR, it was wrong from the start; the same
// period is recorded again and the old value stays in the history as a correction). Pure.
import type { LegalEntity, LegalEntityInput, RegistrationInput } from "@console/api/pending";
import { entityInput, registrationInput } from "./view";

export type Verb = "rev" | "cor";
/** The date chips of a change, none preselected: today, the first of next month, or typed. */
export type When = "today" | "nextMonth" | "typed";

/** The first day of the month after `today` (YYYY-MM-DD). */
export function nextMonthFirst(today: string) {
  const [y, m] = today.split("-").map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
}
export const dateOf = (when: When | null, typed: string, today: string) => (when === "today" ? today : when === "nextMonth" ? nextMonthFirst(today) : when === "typed" ? typed : "");

/** The day before `d` (the end of the period a change closes). */
export function dayBefore(d: string) {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() - 1);
  return t.toISOString().slice(0, 10);
}

/** Reason codes the revision records (free text on the server, ≤ 100). */
export const REASON = { rev: "CHANGE", cor: "CORRECTION" } as const;

/**
 * When the revision takes effect: a change from its chosen date; a correction from the start of the period in
 * force, so that period is recorded again with the right value (the read keeps the newer version of a date).
 */
export function effectiveFrom(verb: Verb, chosen: string, inForceFrom: string | undefined) {
  return verb === "rev" ? chosen : (inForceFrom ?? chosen);
}

/** When the newest scheduled state starts, if any: a change before it would be undone by it, so it starts from there. */
export const scheduledFrom = (e: Pick<LegalEntity, "scheduled">) => e.scheduled.reduce<string | undefined>((a, x) => (!a || x.effective_from > a ? x.effective_from : a), undefined);

/**
 * A change refused locally: it cannot start before the period in force began (that is a correction), nor before a
 * scheduled state (whose full snapshot would undo it from its day on).
 */
/**
 * Whether the value in force keeps a period of its own before a change from `chosen` (company-21): a change on the very
 * day it began replaces it outright, so no period that ends before it starts is ever shown.
 */
export const keepsOldPeriod = (chosen: string, inForceFrom: string) => dayBefore(chosen) >= inForceFrom;

export function revProblem(chosen: string, inForceFrom: string | undefined, scheduled?: string): "beforeInForce" | "beforeScheduled" | null {
  if (!chosen) return null;
  if (inForceFrom && chosen < inForceFrom) return "beforeInForce";
  return scheduled && chosen < scheduled ? "beforeScheduled" : null;
}

/** The newest revision read: the one in force or a later one already scheduled (a later one is refused as stale). */
const readVersion = (e: LegalEntity) => Math.max(e.current?.version ?? 0, ...e.scheduled.map((x) => x.version));

export type EntityPatch = Partial<LegalEntityInput>;
export type RegistrationPatch = Partial<RegistrationInput>;

/**
 * The state in force on `date`: the latest of the current one and those scheduled to start by then. A change dated
 * after a scheduled one builds on it, so the scheduled change is carried, never silently undone.
 */
export function stateOn(e: LegalEntity, date: string) {
  const states = [e.current, ...e.scheduled].filter((x): x is NonNullable<typeof x> => x != null && x.effective_from <= date);
  return states.sort((a, b) => a.effective_from.localeCompare(b.effective_from) || a.version - b.version).at(-1) ?? e.current;
}

/** The entity's full state with the patch applied, for PUT /legal-entities/{id}; null when it cannot be read whole. */
export function entityRevision(e: LegalEntity, patch: EntityPatch, verb: Verb, chosen: string) {
  // a correction rewrites the period in force only; a later scheduled state keeps its old value until the
  // server carries corrections forward (backend ask).
  const base = entityInput(e, verb === "rev" ? stateOn(e, chosen) : e.current);
  if (!base) return null;
  return { ...base, ...patch, effective_from: effectiveFrom(verb, chosen, e.current?.effective_from), reason_code: REASON[verb], expected_version: readVersion(e) };
}

/** A certificate's full state with the patch applied, for PUT /business-registrations/{id}. */
export function registrationRevision(e: LegalEntity, registrationId: string, patch: RegistrationPatch, verb: Verb, chosen: string) {
  const base = registrationInput(e, registrationId);
  const r = e.registrations.find((x) => x.id === registrationId);
  if (!base || !r?.current) return null;
  return {
    ...base,
    ...patch,
    status: r.current.status,
    status_since: r.current.status_since ?? null,
    // A suspension's expected end rides along with any other revision of the certificate (never cleared unasked).
    status_until: r.current.status_until ?? null,
    effective_from: effectiveFrom(verb, chosen, r.current.effective_from),
    reason_code: REASON[verb],
    expected_version: r.current.version,
  };
}
