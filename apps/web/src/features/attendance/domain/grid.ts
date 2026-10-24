// The month grid's pure parts: cell keys, range selection, drafts over a selection, paste by employee number,
// fill-as-scheduled, and the day ledger's partition. The grid component only draws what these return.
import { parseDraft, type DraftCode } from "./grammar";

type Pos = { r: number; c: number };

export const cellKey = (employeeId: string, date: string) => `${employeeId}|${date}`;
export const splitKey = (key: string) => {
  const [employee_id, work_date] = key.split("|") as [string, string];
  return { employee_id, work_date };
};

export type Draft = { value: string; base: string | null };
export type Drafts = Readonly<Record<string, Draft>>;
type DraftState = { ok: true } | { ok: false; code: DraftCode; at?: number };
export const draftState = (d: Draft, planKind: string | undefined): DraftState => {
  const p = parseDraft(d.value, undefined, false, { kind: planKind });
  return p.ok ? { ok: true } : { ok: false, code: p.code, at: p.at };
};

/**
 * A draft's If-Match base: the version the person saw when they began. An existing draft keeps its base (they still see
 * their draft, not what changed under it), so a save over someone else's newer write is a 409, never a silent overwrite.
 */
export const baseOf = (drafts: Drafts, key: string, current: string | null) => (key in drafts ? drafts[key]!.base : current);

/** What a grid cell holds for the drafting tools: its plan kind and the entry the typist sees (If-Match base). */
export type CellFacts = { key: string; planKind: string | undefined; entryId: string | null; own: boolean; closed: boolean };

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
  const skipped = { rest: 0, recorded: 0, locked: 0, unscheduled: 0 };
  let filled = 0;
  for (const c of cells) {
    if (c.own || c.closed) skipped.locked += 1;
    else if (c.planKind === "NO_SCHEDULE") skipped.unscheduled += 1;
    else if (c.planKind !== "WORK") skipped.rest += 1;
    else if (c.entryId) skipped.recorded += 1;
    else {
      next[c.key] = { value: "=", base: baseOf(drafts, c.key, null) };
      filled += 1;
    }
  }
  return { drafts: next, filled, skipped };
}

export type PasteRefusal = "employeeNumberHeader" | "employeeNumberRequired" | "dayHeaderRequired" | "wrongMonth" | "dayOutsideMonth" | "duplicateDay" | "unlabelledMultiRow" | "unsupportedRowType" | "clockOutOnly" | "noCells";
export type PasteResult = {
  cells: { r: number; c: number; date: string; value: string }[];
  identities: { r: number; name: string; department: string }[];
  matched: number;
  missing: string[];
  ignoredColumns: string[];
  refusal: PasteRefusal | null;
};

// These are input syntax, not rendered copy; keep the Korean labels escaped like the cell grammar.
const idAliases = ["\u{c0ac}\u{bc88}", "\u{c0ac}\u{c6d0}\u{bc88}\u{d638}", "\u{c9c1}\u{c6d0}\u{bc88}\u{d638}", "\u{c9c1}\u{c6d0}\u{cf54}\u{b4dc}", "\u{c0ac}\u{c6d0}\u{cf54}\u{b4dc}", "\u{ce74}\u{b4dc}\u{bc88}\u{d638}", "\u{c0ac}\u{c6a9}\u{c790}id", "employeeno", "employeenumber", "employeeid"];
const nameAliases = ["\u{c131}\u{ba85}", "\u{c774}\u{b984}", "\u{c9c1}\u{c6d0}\u{ba85}", "\u{c0ac}\u{c6d0}\u{ba85}", "\u{c9c1}\u{c6d0}\u{c774}\u{b984}", "name"];
const departmentAliases = ["\u{bd80}\u{c11c}", "\u{bd80}\u{c11c}\u{ba85}", "\u{c18c}\u{c18d}", "\u{c870}\u{c9c1}", "\u{adfc}\u{bb34}\u{bd80}\u{c11c}", "department"];
const roleAliases = ["\u{ad6c}\u{bd84}", "\u{d56d}\u{baa9}", "\u{c720}\u{d615}", "\u{adfc}\u{d0dc}\u{ad6c}\u{bd84}", "\u{adfc}\u{bb34}\u{ad6c}\u{bd84}", "\u{cd9c}\u{d1f4}\u{adfc}\u{ad6c}\u{bd84}", "\u{ae30}\u{b85d}\u{ad6c}\u{bd84}", "rowtype"];
const MONTH_WORD = "\u{c6d4}";
const DAY_WORD = "\u{c77c}";
const YEAR_WORD = "\u{b144}";
const WEEKDAYS = ["\u{c6d4}", "\u{d654}", "\u{c218}", "\u{baa9}", "\u{ae08}", "\u{d1a0}", "\u{c77c}"];
const label = (s: string) => s.normalize("NFKC").trim().toLocaleLowerCase().replace(/\([^)]*\)/g, "").replace(/[\s:：·]/g, "");
const hasAlias = (value: string, aliases: readonly string[]) => {
  const x = label(value);
  return aliases.some((a) => x === a || x.startsWith(a));
};
const employeeKey = (value: string) => value.normalize("NFKC").trim();

/** Read a day label, checking an explicit month when one is present. Grid columns are always selected by this day, never by source position. */
function dayNumber(value: string, month: string): number | null {
  const x = value.normalize("NFKC").trim().replace(/\s/g, "");
  let m = x.match(/^(\d{4})[-./](\d{1,2})[-./](\d{1,2})$/);
  if (m) return `${m[1]}-${m[2]!.padStart(2, "0")}` === month ? Number(m[3]) : -1;
  m = x.match(/^(\d{1,2})[./](\d{1,2})$/);
  if (m) return Number(m[1]) === Number(month.slice(5, 7)) ? Number(m[2]) : -1;
  m = new RegExp(`^(\\d{1,2})${MONTH_WORD}(\\d{1,2})(?:${DAY_WORD})?(?:\\([^)]*\\))?$`).exec(x);
  if (m) return Number(m[1]) === Number(month.slice(5, 7)) ? Number(m[2]) : -1;
  m = new RegExp(`^(\\d{1,2})(?:${DAY_WORD})?(?:\\([^)]*\\))?$`).exec(x);
  return m ? Number(m[1]) : null;
}

function rowKind(value: string): "in" | "out" | null {
  const x = label(value);
  if (["\u{cd9c}\u{adfc}", "\u{cd9c}\u{adfc}\u{c2dc}\u{ac04}", "\u{c2dc}\u{c791}"].includes(x)) return "in";
  if (["\u{d1f4}\u{adfc}", "\u{d1f4}\u{adfc}\u{c2dc}\u{ac04}", "\u{c885}\u{b8cc}"].includes(x)) return "out";
  return null;
}

/** Parse a paste into a reviewed draft plan. Names and departments are display-only; only the declared employee number binds a row. */
export function readPaste(text: string, numbers: readonly (string | null)[], days: readonly string[], anchor: Pos): PasteResult {
  const rows = text.replace(/\r/g, "").split("\n").map((line) => line.split("\t")).filter((row) => row.some((cell) => cell.trim() !== ""));
  const month = days[0]?.slice(0, 7) ?? "";
  const byNumber = new Map(numbers.map((n, i) => [n ? employeeKey(n) : "", i] as const).filter(([n]) => n));
  const empty = (refusal: PasteRefusal, missing: string[] = [], ignoredColumns: string[] = []): PasteResult => ({
    cells: [], identities: [], matched: 0, missing, ignoredColumns, refusal,
  });
  if (!rows.length || !month) return empty("noCells");

  let header = -1;
  let idCol = -1;
  let nameCol = -1;
  let departmentCol = -1;
  let roleCol = -1;
  let dayCols: { col: number; day: number }[] = [];
  let identityHeader = false;
  let wrongMonthHeader = false;
  for (let r = 0; r < rows.length; r += 1) {
    const row = rows[r]!;
    const id = row.findIndex((x) => hasAlias(x, idAliases));
    const name = row.findIndex((x) => hasAlias(x, nameAliases));
    const department = row.findIndex((x) => hasAlias(x, departmentAliases));
    const role = row.findIndex((x) => hasAlias(x, roleAliases));
    const hasIdentity = id >= 0 || name >= 0 || department >= 0;
    const parsedDays = row.flatMap((value, col) => {
      const day = dayNumber(value, month);
      return day !== null && day > 0 ? [{ col, day }] : [];
    });
    if (hasIdentity) {
      identityHeader = true;
      wrongMonthHeader ||= row.some((value) => dayNumber(value, month) === -1);
      if (parsedDays.length) {
        header = r;
        idCol = id;
        nameCol = name;
        departmentCol = department;
        roleCol = role;
        dayCols = parsedDays;
        break;
      }
    }
  }

  if (identityHeader && header < 0) return empty(wrongMonthHeader ? "wrongMonth" : "dayHeaderRequired");
  if (header >= 0) {
    if (idCol < 0) return empty("employeeNumberHeader");
    if (wrongMonthHeader) return empty("wrongMonth");
    const titleMonth = rows.slice(0, header).map((r) => r.join(" ")).join(" ").match(new RegExp(`((?:19|20)\\d{2})\\s*${YEAR_WORD}\\s*(\\d{1,2})\\s*${MONTH_WORD}`));
    if (titleMonth && `${titleMonth[1]}-${titleMonth[2]!.padStart(2, "0")}` !== month) return empty("wrongMonth");
    const seenDays = new Set<number>();
    const dateByDay = new Map(days.map((date) => [Number(date.slice(8, 10)), date] as const));
    for (const d of dayCols) {
      if (seenDays.has(d.day)) return empty("duplicateDay");
      seenDays.add(d.day);
      if (!dateByDay.has(d.day)) return empty("dayOutsideMonth");
    }
    const ignoredColumns = rows[header]!.flatMap((x, col) =>
      col !== idCol && col !== nameCol && col !== departmentCol && col !== roleCol && !dayCols.some((d) => d.col === col) && x.trim()
        ? [x.trim()]
        : [],
    );
    const records = new Map<number, { plain: Map<number, string>; in: Map<number, string>; out: Map<number, string> }>();
    const identities = new Map<number, { r: number; name: string; department: string }>();
    const missing = new Set<string>();
    const matched = new Set<number>();
    let currentNumber = "";
    let skippedWeekdayHeader = false;
    for (const row of rows.slice(header + 1)) {
      const rawNumber = employeeKey(row[idCol] ?? "");
      const roleValue = roleCol < 0 ? "" : (row[roleCol] ?? "").trim();
      const kind = roleValue ? rowKind(roleValue) : null;
      const values = dayCols.map(({ col, day }) => ({ day, value: (row[col] ?? "").trim() })).filter((x) => x.value);
      if (!skippedWeekdayHeader && !rawNumber && !roleValue && values.length && values.every(({ value }) => {
        const x = value.normalize("NFKC").trim();
        return WEEKDAYS.some((day) => x === day || x === `${day}\u{c694}\u{c77c}`) || /^(mon|tue|wed|thu|fri|sat|sun)(day)?$/i.test(x);
      })) {
        skippedWeekdayHeader = true;
        continue;
      }
      if (!rawNumber && !roleValue && values.length) return empty(currentNumber ? "unlabelledMultiRow" : "employeeNumberRequired", [...missing], ignoredColumns);
      if (roleValue && !kind) return empty("unsupportedRowType", [...missing], ignoredColumns);
      const number = rawNumber || (kind ? currentNumber : "");
      if (rawNumber) currentNumber = rawNumber;
      if (!number && values.length) return empty("employeeNumberRequired", [...missing], ignoredColumns);
      if (!number || !values.length) continue;
      const r = byNumber.get(number);
      if (r === undefined) {
        missing.add(number);
        continue;
      }
      matched.add(r);
      const identity = identities.get(r) ?? { r, name: "", department: "" };
      if (nameCol >= 0 && row[nameCol]?.trim()) identity.name = row[nameCol]!.trim();
      if (departmentCol >= 0 && row[departmentCol]?.trim()) identity.department = row[departmentCol]!.trim();
      identities.set(r, identity);
      const record = records.get(r) ?? { plain: new Map<number, string>(), in: new Map<number, string>(), out: new Map<number, string>() };
      const target = kind === "in" ? record.in : kind === "out" ? record.out : record.plain;
      for (const { day, value } of values) {
        if (target.has(day)) return empty(kind ? "unsupportedRowType" : "unlabelledMultiRow", [...missing], ignoredColumns);
        target.set(day, value);
      }
      records.set(r, record);
    }
    const cells: PasteResult["cells"] = [];
    for (const [r, record] of records) {
      if (record.plain.size && (record.in.size || record.out.size)) return empty("unlabelledMultiRow", [...missing], ignoredColumns);
      const allDays = new Set([...record.plain.keys(), ...record.in.keys(), ...record.out.keys()]);
      for (const day of allDays) {
        const value = record.plain.get(day) ?? (record.in.has(day)
          ? `${record.in.get(day)}-${record.out.get(day) ?? ""}`
          : record.out.has(day) ? "" : "");
        if (record.out.has(day) && !record.in.has(day)) return empty("clockOutOnly", [...missing], ignoredColumns);
        const c = days.indexOf(dateByDay.get(day)!);
        if (value) cells.push({ r, c, date: dateByDay.get(day)!, value });
      }
    }
    return cells.length
      ? { cells, identities: [...identities.values()], matched: matched.size, missing: [...missing], ignoredColumns, refusal: null }
      : empty("noCells", [...missing], ignoredColumns);
  }

  const cells: PasteResult["cells"] = [];
  const mappedTargets = new Set<string>();
  const missing = new Set<string>();
  const matched = new Set<number>();
  const add = (r: number, c: number, value: string) => {
    if (!value) return true;
    const date = days[c];
    if (!date) return false;
    const key = `${r}|${date}`;
    if (mappedTargets.has(key)) return false;
    mappedTargets.add(key);
    cells.push({ r, c, date, value });
    return true;
  };
  if (rows.length === 1 && !byNumber.has(employeeKey(rows[0]![0] ?? ""))) {
    for (const [i, value] of rows[0]!.entries()) if (!add(anchor.r, anchor.c + i, value.trim())) return empty("dayOutsideMonth");
    return cells.length ? { cells, identities: [], matched: 1, missing: [], ignoredColumns: [], refusal: null } : empty("noCells");
  }
  for (const row of rows) {
    const number = employeeKey(row[0] ?? "");
    if (!number && row.slice(1).some((value) => value.trim())) return empty(matched.size ? "unlabelledMultiRow" : "employeeNumberRequired", [...missing]);
    const r = byNumber.get(number);
    if (r === undefined) {
      if (number) missing.add(number);
      continue;
    }
    matched.add(r);
    for (const [i, value] of row.slice(1).entries()) if (!add(r, anchor.c + i, value.trim())) return empty(days[anchor.c + i] ? "unlabelledMultiRow" : "dayOutsideMonth", [...missing]);
  }
  if (!cells.length) return empty(rows.length > 1 ? "employeeNumberRequired" : "noCells", [...missing]);
  return { cells, identities: [], matched: matched.size, missing: [...missing], ignoredColumns: [], refusal: null };
}

type Ledger = {
  people: number; no_schedule: number; rest: number; no_record: number; missing_out: number; absent: number;
  outside: number; trip: number; late_or_early: number; normal: number; pending: number;
};
const PARTS = ["no_schedule", "rest", "no_record", "missing_out", "absent", "outside", "trip", "late_or_early", "normal", "pending"] as const;
/** The ledger's parts in reading order, and whether they add up to the people in scope (G8: a gap is a bug). */
export const ledgerParts = (l: Ledger) => ({ parts: PARTS.map((k) => [k, l[k]] as const), adds: PARTS.reduce((n, k) => n + l[k], 0) === l.people });
