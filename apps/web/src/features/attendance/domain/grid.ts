// The month grid's pure parts: cell keys, range selection, drafts over a selection, paste by employee number,
// fill-as-scheduled, and the day ledger's partition. The grid component only draws what these return.
import { parseEntry, type ParseCode } from "./grammar";

type Pos = { r: number; c: number };

export const cellKey = (employeeId: string, date: string) => `${employeeId}|${date}`;
export const splitKey = (key: string) => {
  const [employee_id, work_date] = key.split("|") as [string, string];
  return { employee_id, work_date };
};

export type Draft = { value: string; base: string | null };
export type Drafts = Readonly<Record<string, Draft>>;
type DraftState = { ok: true } | { ok: false; code: ParseCode; at?: number };
export const draftState = (d: Draft): DraftState => {
  const p = parseEntry(d.value);
  return p.ok ? { ok: true } : { ok: false, code: p.code, at: p.at };
};

/**
 * A draft's If-Match base: the version the person saw when they began. An existing draft keeps its base (they still see
 * their draft, not what changed under it), so a save over someone else's newer write is a 409, never a silent overwrite.
 */
export const baseOf = (drafts: Drafts, key: string, current: string | null) => (key in drafts ? drafts[key]!.base : current);

/** What a grid cell holds for the drafting tools: its plan kind and the entry the typist sees (If-Match base). */
export type CellFacts = { key: string; planKind: string; entryId: string | null; own: boolean; closed: boolean };

/** One value into every writable cell of a selection (⌘↵, fill down); own and closed cells are skipped and counted. */
export function fill(cells: readonly CellFacts[], value: string, drafts: Drafts) {
  const next: Record<string, Draft> = { ...drafts };
  let skipped = 0;
  for (const c of cells) {
    if (c.own || c.closed) skipped += 1;
    else next[c.key] = { value, base: baseOf(drafts, c.key, c.entryId) };
  }
  return { drafts: next, skipped };
}

/** Fill as scheduled (A3-fill): only empty work days; rest days, holidays, saved days, own and closed cells are skipped. */
export function fillSchedule(cells: readonly CellFacts[], drafts: Drafts) {
  const next: Record<string, Draft> = { ...drafts };
  const skipped = { rest: 0, recorded: 0, locked: 0 };
  let filled = 0;
  for (const c of cells) {
    if (c.own || c.closed) skipped.locked += 1;
    else if (c.planKind !== "WORK") skipped.rest += 1;
    else if (c.entryId) skipped.recorded += 1;
    else {
      next[c.key] = { value: "=", base: baseOf(drafts, c.key, null) };
      filled += 1;
    }
  }
  return { drafts: next, filled, skipped };
}

/**
 * A paste (⌘V). Several rows need the employee number in the first column (matched to the grid's rows, never by
 * name); one row without it goes across from the anchor. Returns the cells by row index and the match counts.
 */
export function readPaste(text: string, numbers: readonly (string | null)[], anchor: Pos) {
  const lines = text.replace(/\r/g, "").split("\n").filter((l) => l.trim() !== "");
  const byNumber = new Map(numbers.map((n, i) => [n?.trim(), i] as const).filter(([n]) => n));
  const cells: { r: number; c: number; value: string }[] = [];
  let matched = 0;
  const missing: string[] = [];
  if (lines.length === 1 && !byNumber.has(lines[0]!.split("\t")[0]!.trim())) {
    lines[0]!.split("\t").forEach((v, i) => cells.push({ r: anchor.r, c: anchor.c + i, value: v.trim() }));
    return { cells, matched: 1, missing, needsNumber: false };
  }
  for (const line of lines) {
    const [number, ...values] = line.split("\t");
    const r = byNumber.get(number!.trim());
    if (r === undefined) {
      missing.push(number!.trim());
      continue;
    }
    matched += 1;
    values.forEach((v, i) => v.trim() && cells.push({ r, c: anchor.c + i, value: v.trim() }));
  }
  return { cells, matched, missing, needsNumber: matched === 0 && lines.length > 1 };
}

type Ledger = {
  people: number; no_schedule: number; rest: number; no_record: number; missing_out: number; absent: number;
  outside: number; trip: number; late_or_early: number; normal: number; pending: number;
};
const PARTS = ["no_schedule", "rest", "no_record", "missing_out", "absent", "outside", "trip", "late_or_early", "normal", "pending"] as const;
/** The ledger's parts in reading order, and whether they add up to the people in scope (G8: a gap is a bug). */
export const ledgerParts = (l: Ledger) => ({ parts: PARTS.map((k) => [k, l[k]] as const), adds: PARTS.reduce((n, k) => n + l[k], 0) === l.people });
