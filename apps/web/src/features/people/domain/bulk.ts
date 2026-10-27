// Bulk appointment: a paste keyed by employee number (number · new unit or new position · name), matched against the
// server's records, checked line by line and grouped into one all-or-nothing batch per target. The server still
// decides each line at commit; the checks here only point at lines it would refuse or cannot read.
import type { components } from "@console/api/schema";
import { readDelimited } from "../../../lib/pure/sheet-text";

type Employee = components["schemas"]["Employee"];
export type Kind = "TRANSFER" | "PROMOTE";

/** The bulk endpoint's limit on employees per batch (BulkEmployeeLifecycleEventRequest.employee_ids maxItems). */
export const MAX_LINES = 500;

/** One pasted line, after duplicates of its employee number were merged into it (`merged` holds their line numbers). */
export type PasteLine = { line: number; number: string; target: string; name: string; merged: number[]; issue?: "conflict" | "overLimit" };

const same = (a: string, b: string) => a.replace(/\s+/g, "") === b.replace(/\s+/g, "");

/**
 * Tab-separated (a spreadsheet copy) or comma-separated lines. A first line without a digit in its first cell is a
 * header and is skipped; blank lines are ignored. A repeated employee number merges into its first line, and is a
 * conflict when it names another target or name. Employee numbers past the batch limit are refused, never dropped.
 */
export function parsePaste(text: string): PasteLine[] {
  const out: PasteLine[] = [];
  const seen = new Map<string, PasteLine>();
  let first = true;
  readDelimited(text, { delimiter: "mixed" }).forEach((raw, i) => {
    if (!raw.some((cell) => cell.trim())) return;
    const [number = "", target = "", name = ""] = raw.map((cell) => cell.trim());
    if (first && (first = false, !/\d/.test(number))) return;
    const key = number.toUpperCase();
    const prev = seen.get(key);
    if (prev) {
      prev.merged.push(i + 1);
      if (!same(prev.target, target) || (name && prev.name && !same(prev.name, name))) prev.issue = "conflict";
      return;
    }
    const line: PasteLine = { line: i + 1, number, target, name, merged: [], issue: seen.size >= MAX_LINES ? "overLimit" : undefined };
    seen.set(key, line);
    out.push(line);
  });
  return out;
}

/** A unit a line may name: its own name, or its full path as the org chart shows it ("HQ › HR"). */
export type UnitRef = { id: string; name: string; path: string };

/** Exact name first, then exact path; never a partial match. */
export function matchUnit(text: string, units: readonly UnitRef[]): UnitRef[] {
  const byName = units.filter((u) => same(u.name, text));
  return byName.length ? byName : units.filter((u) => same(u.path, text));
}

/** Stops the line: fix the paste or take the line out. */
export type Problem = "overLimit" | "conflict" | "notFound" | "numberAmbiguous" | "nameMismatch" | "targetMissing" | "unitNotFound" | "unitAmbiguous";
/** A precondition the server checks at commit, shown before it refuses the batch (never decided here). */
export type Hint = "onLeave" | "exited" | "sameUnit" | "samePosition";

export type Row = {
  /** Stable across re-checks: the pasted line number, or the employee id for a roster selection. */
  key: string;
  line?: number;
  number?: string;
  pastedName?: string;
  merged: number[];
  employee?: Employee;
  /** The line's own target text (a unit name or path, or a position); "" uses the sheet's target. */
  target: string;
  /** The unit a transfer line resolves to. */
  unitId?: string;
  /** Units sharing the pasted name, to choose from. */
  candidates?: UnitRef[];
  problem?: Problem;
  hint?: Hint;
};

/** What the sheet chose for every line without its own target. */
export type SheetTarget = { unitId?: string; position?: string };

/** The server's single-event rules a line can be seen to break before commit. */
export function hintFor(e: Employee, kind: Kind | null, unitId?: string, position?: string): Hint | undefined {
  if (e.status === "ON_LEAVE") return "onLeave";
  if (e.status === "EXITED") return "exited";
  if (kind === "TRANSFER" && unitId && e.org_unit_id === unitId) return "sameUnit";
  if (kind === "PROMOTE" && position && e.position && same(e.position, position)) return "samePosition";
  return undefined;
}

/**
 * Matches each pasted line to exactly one employee by employee number (case-insensitive) and, for a transfer, to
 * one unit. `picks` holds the unit the user chose for a line whose unit was ambiguous or not found.
 */
export function resolvePaste(lines: readonly PasteLine[], o: { employees: readonly Employee[]; units: readonly UnitRef[]; kind: Kind | null; sheet: SheetTarget; picks: Readonly<Record<string, string>> }): Row[] {
  const byNumber = new Map<string, Employee[]>();
  for (const e of o.employees) {
    const k = e.employee_number?.toUpperCase();
    if (k) byNumber.set(k, [...(byNumber.get(k) ?? []), e]);
  }
  const perLine = lines.some((l) => l.target);
  return lines.map((l) => {
    const row: Row = { key: String(l.line), line: l.line, number: l.number, pastedName: l.name || undefined, merged: l.merged, target: l.target };
    if (l.issue) return { ...row, problem: l.issue };
    const found = byNumber.get(l.number.toUpperCase()) ?? [];
    if (found.length !== 1) return { ...row, problem: found.length ? "numberAmbiguous" : "notFound" };
    const e = found[0]!;
    row.employee = e;
    if (l.name && !same(l.name, e.name)) return { ...row, problem: "nameMismatch" };
    if (!o.kind) return row;
    if (perLine && !l.target) return { ...row, problem: "targetMissing" };
    if (o.kind === "PROMOTE") {
      const position = perLine ? l.target : o.sheet.position;
      return { ...row, hint: hintFor(e, o.kind, undefined, position) };
    }
    let unitId = perLine ? o.picks[row.key] : o.sheet.unitId;
    if (perLine && !unitId) {
      const hits = matchUnit(l.target, o.units);
      if (hits.length !== 1) return { ...row, candidates: hits.length ? hits : undefined, problem: hits.length ? "unitAmbiguous" : "unitNotFound" };
      unitId = hits[0]!.id;
    }
    return { ...row, unitId, hint: hintFor(e, o.kind, unitId) };
  });
}

/**
 * A roster selection, re-read: each picked id against the records just read (so a status or unit that changed since
 * the pick shows), with the name seen at the pick for a person no longer listed.
 */
export function selectionRows(picked: ReadonlyMap<string, string>, employees: readonly Employee[], kind: Kind | null, sheet: SheetTarget): Row[] {
  const byId = new Map(employees.map((e) => [e.id, e]));
  return [...picked].map(([id, name]) => {
    const e = byId.get(id);
    const row: Row = { key: id, merged: [], target: "", pastedName: name || undefined };
    return e ? { ...row, employee: e, unitId: sheet.unitId, hint: hintFor(e, kind, sheet.unitId, sheet.position) } : { ...row, problem: "notFound" };
  });
}

/** One batch per target (a unit for a transfer, a position for a promotion), in order of first appearance. */
export type Group = { target: string; rows: Row[] };

export function groupRows(rows: readonly Row[], kind: Kind, sheet: SheetTarget): Group[] {
  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    if (r.problem || !r.employee) continue;
    const target = kind === "TRANSFER" ? (r.unitId ?? sheet.unitId) : (r.target || sheet.position)?.trim();
    if (!target) continue;
    groups.set(target, [...(groups.get(target) ?? []), r]);
  }
  return [...groups].map(([target, rs]) => ({ target, rows: rs }));
}

/** Rows that stop the commit come first, then those the server may refuse, then the rest, each in pasted order. */
export const errorsFirst = (rows: readonly Row[]) => [...rows].sort((a, b) => rank(a) - rank(b));
const rank = (r: Row) => (r.problem ? 0 : r.hint ? 1 : 2);

// Dates (YYYY-MM-DD, business dates in Korea).
const ymd = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10);
const year = (today: string) => Number(today.slice(0, 4));
const month = (today: string) => Number(today.slice(5, 7)) - 1;
export const nextMonthFirst = (today: string) => ymd(year(today), month(today) + 1, 1);
export const monthEnd = (today: string) => ymd(year(today), month(today) + 1, 0);

/** No date yet; already in effect (today, or a past date the server records as of then); or scheduled. */
export type When = "none" | "past" | "today" | "future";
export const whenOf = (date: string, today: string): When =>
  !/^\d{4}-\d{2}-\d{2}$/.test(date) ? "none" : date < today ? "past" : date === today ? "today" : "future";

/** The first refusal in the sheet's reading order; counts describe actual missing fields or rows. */
export function bulkBlock(v: { missingCount: number; errorLines: number; count: number; checking: boolean; failed: boolean; progress: { done: number; total: number } }) {
  if (v.missingCount) return { id: "bulk.missing", params: { count: v.missingCount } } as const;
  if (v.errorLines) return { id: "bulk.errorsLeft", params: { count: v.errorLines } } as const;
  if (v.failed) return { id: "bulk.paste.failed" } as const;
  if (v.checking) return { id: "bulk.paste.checking", params: v.progress } as const;
  if (!v.count) return { id: "bulk.noTargets" } as const;
  return null;
}
