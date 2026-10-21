// A grant draft (design §2.3(c), contract AccessGrantOpGrant): role × scope × end, several per person under one reason.
// Nothing is preselected, and an explicit grant always ends (design §9.2): the end is the last day it counts. The wire end
// is exclusive (RFC 3339).
import { addDays, addMonths } from "../../../ui/date/days";
import { todayKst } from "../../../lib/pure/today";
import { sameScope, type Scope } from "./scope";

export type DraftLine = { key: string; role_id: string | null; scope: Scope | null; end: string | null };
export type Missing = "role" | "scope" | "end" | "end_past" | "duplicate";

/** End-date chips: the day before the 3-month, 6-month and 1-year mark from `start`. */
export const endPresets = (start: string) =>
  ([["m3", 3], ["m6", 6], ["y1", 12]] as const).map(([id, months]) => ({ id, date: addDays(addMonths(start, months), -1) }));

/** The exclusive wire end for a last day (KST midnight after it). */
export const endToWire = (end: string) => `${addDays(end, 1)}T00:00:00+09:00`;

/** The last day an exclusive wire end still counts, as a KST date; null = open-ended. */
export const lastDay = (validTo: string | null | undefined) => (validTo ? todayKst(new Date(Date.parse(validTo) - 1)) : null);

/** What a line still needs before it can be sent, in the order the form shows it. */
export function missing(line: DraftLine, all: readonly DraftLine[], today: string): Missing[] {
  const out: Missing[] = [];
  if (!line.role_id) out.push("role");
  if (!line.scope) out.push("scope");
  if (!line.end) out.push("end");
  else if (line.end < today) out.push("end_past");
  if (line.role_id && line.scope && all.some((o) => o.key !== line.key && o.role_id === line.role_id && o.scope && sameScope(o.scope, line.scope!))) out.push("duplicate");
  return out;
}

export type ReadyLine = { role_id: string; scope: Scope; end: string };
export const ready = (l: DraftLine): l is DraftLine & ReadyLine => !!l.role_id && !!l.scope && !!l.end;

/** The wire start for a first day (KST midnight that begins it). */
export const startToWire = (start: string) => `${start}T00:00:00+09:00`;

/** The grant operation one ready line sends for an account; `start` (ROL-M4-grant-op) dates it to a later first day. */
export const grantOp = (account_id: string, l: ReadyLine, effective_in_setup: boolean, start?: string | null) => ({
  op: "grant" as const,
  account_id,
  role_id: l.role_id,
  scope: l.scope,
  ...(start && { valid_from: startToWire(start) }),
  valid_to: endToWire(l.end),
  effective_in_setup,
});

/** An empty line; `key` tells lines apart while they are edited (the caller makes it, e.g. crypto.randomUUID()). */
export const blankLine = (key: string): DraftLine => ({ key, role_id: null, scope: null, end: null });

/** When an operating grant starts (ROL-M4-grant-op): on save, or from a chosen day; nothing is preselected. */
export type Start = { when: string | null; date: string };
/** Whether the start still blocks a save: none chosen, or a date that is missing or before today. */
export const startProblem = (v: Start, today: string) => !v.when || (v.when === "DATE" && (!v.date || v.date < today));
