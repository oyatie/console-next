// The entry grammar (spec A3), the same table the server re-parses (attendance domain records/grammar.rs):
//   9-18 · 0900-1800 · 09:00~18:00 · 9:30-18:15 · 6:50-16 · 22-6+ (ends next day) · 9-18/90 (90 minutes away)
//   9-12,13:30-18 (time away) · 7:52- (in only) · = (as scheduled) · x (absent) · o (outside work) · business trip
// Refused: +2 or 18+2 (overtime is only an approval record), unconfirmed policy-long spans, 22-6 without the +. A draft is checked here so the
// typist sees the refusal at once; the server's answer is the one that counts.
import type { Window } from "./minutes";

type Entry =
  | { kind: "TIMES"; spans: Window[] }
  | { kind: "CLOCK_IN_ONLY"; start: number }
  | { kind: "AS_SCHEDULED" }
  | { kind: "ABSENT" }
  | { kind: "OUTSIDE_WORK" }
  | { kind: "BUSINESS_TRIP" };

export type ParseCode = "overtime_typed" | "entry_unreadable" | "overnight_without_marker" | "span_too_long" | "spans_overlap";
type Parsed = { ok: true; entry: Entry } | { ok: false; code: ParseCode; at?: number };

// The Korean code words are input syntax, not copy: written as escapes so no Hangul sits outside the catalogs
// (as scheduled, absent, outside work, business trip: the same words the server accepts).
const CODES: Record<string, Entry> = {
  "=": { kind: "AS_SCHEDULED" },
  "\u{c18c}\u{c815}": { kind: "AS_SCHEDULED" },
  x: { kind: "ABSENT" },
  X: { kind: "ABSENT" },
  "\u{acb0}\u{adfc}": { kind: "ABSENT" },
  o: { kind: "OUTSIDE_WORK" },
  O: { kind: "OUTSIDE_WORK" },
  "\u{c678}\u{adfc}": { kind: "OUTSIDE_WORK" },
  "\u{cd9c}\u{c7a5}": { kind: "BUSINESS_TRIP" },
};

/** `9`, `09`, `9:30`, `0930` → minutes; 24:00 only as 1440. */
function clock(raw: string): number | null {
  const s = raw.trim();
  const m = /^(\d{1,2})(?::(\d{2}))?$/.exec(s) ?? /^(\d{2})(\d{2})$/.exec(s);
  if (!m) return null;
  const h = Number(m[1]);
  const min = m[2] === undefined ? 0 : Number(m[2]);
  return min < 60 && h * 60 + min <= 1440 ? h * 60 + min : null;
}

const refuse = (code: ParseCode, at?: number): Parsed => ({ ok: false, code, at });
/** The first character that is not part of a time (the console boxes it: 「6:5O-16」). */
const badAt = (v: string) => {
  const i = [...v].findIndex((c) => !/[\d:~\-,/+ ]/.test(c));
  return i < 0 ? undefined : i;
};

export function parseEntry(raw: string, longSpanMinutes?: number, confirmed = false): Parsed {
  if (raw.length > 40 * 2 || [...raw].length > 40) return refuse("entry_unreadable");
  const v = raw.trim();
  if (Object.hasOwn(CODES, v)) return { ok: true, entry: CODES[v]! };
  if (!v) return refuse("entry_unreadable");
  const nextDay = v.endsWith("+");
  const body = nextDay ? v.slice(0, -1).trimEnd() : v;
  if (body.includes("+")) return refuse("overtime_typed");
  if (/[-~]$/.test(body)) {
    const start = clock(body.slice(0, -1));
    return start !== null && start < 1440 ? { ok: true, entry: { kind: "CLOCK_IN_ONLY", start } } : refuse("entry_unreadable", badAt(v));
  }
  const [spansRaw, awayRaw, extra] = body.split("/");
  if (extra !== undefined) return refuse("entry_unreadable", badAt(v));
  const away = awayRaw === undefined ? null : /^\d+$/.test(awayRaw.trim()) ? Number(awayRaw) : NaN;
  if (Number.isNaN(away)) return refuse("entry_unreadable", badAt(v));
  const spans: Window[] = [];
  let shift = 0;
  for (const part of spansRaw!.split(",")) {
    const [a, b, more] = part.split(/[-~]/);
    if (b === undefined || more !== undefined) return refuse("entry_unreadable", badAt(v));
    const s0 = clock(a!);
    const e0 = clock(b);
    if (s0 === null || e0 === null) return refuse("entry_unreadable", badAt(v));
    let start = s0 + shift;
    let end = e0 + shift;
    const prev = spans.at(-1)?.end;
    if (prev !== undefined && start < prev && nextDay && shift === 0) {
      shift = 1440;
      start += 1440;
      end += 1440;
    }
    if (end <= start) {
      if (!nextDay || end >= 1440) return refuse("overnight_without_marker");
      end += 1440;
    }
    if (start >= end || start >= 2880 || end > 2880 || (spans.length === 0 && start >= 1440)) return refuse("entry_unreadable");
    if (prev !== undefined && start < prev) return refuse("spans_overlap");
    spans.push({ start, end });
  }
  if (longSpanMinutes !== undefined && spans.at(-1)!.end - spans[0]!.start > longSpanMinutes && !confirmed) return refuse("span_too_long");
  if (away !== null) {
    const one = spans[0]!;
    if (spans.length !== 1 || away <= 0 || away >= one.end - one.start - 1) return refuse("entry_unreadable");
    const mid = one.start + Math.floor((one.end - one.start - away) / 2);
    return { ok: true, entry: { kind: "TIMES", spans: [{ start: one.start, end: mid }, { start: mid + away, end: one.end }] } };
  }
  return { ok: true, entry: { kind: "TIMES", spans } };
}

/** Recorded minutes of a parsed entry (a draft's own number, before the server's recognition). */
export const recordedMinutes = (e: Entry) => (e.kind === "TIMES" ? e.spans.reduce((n, w) => n + w.end - w.start, 0) : 0);

/**
 * A likely intended value for a refused one, offered as one fix chip (7:48-5:10 → 7:48-17:10): an afternoon end typed in
 * 12-hour form, or a letter O typed for a zero. Null when nothing plausible exists.
 */
export function suggestFix(raw: string): string | null {
  const zero = raw.replace(/[oO]/g, "0");
  if (zero !== raw && parseEntry(zero).ok) return zero;
  const m = /^(\d{1,2}(?::\d{2})?)\s*[-~]\s*(\d{1,2})(:\d{2})?$/.exec(raw.trim());
  if (m && Number(m[2]) < 12) {
    const fix = `${m[1]}-${Number(m[2]) + 12}${m[3] ?? ""}`;
    if (parseEntry(fix).ok) return fix;
  }
  return null;
}
