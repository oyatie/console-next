// The entry grammar (spec A3, input patterns 2.1), the same table the server re-parses (attendance domain records/grammar.rs);
// both run every case in scripts/fixtures/attendance-grammar-cases.json:
//   9-18 · 0900-1800 · 09:00~18:00 · 9:30-18:15 · 6:50-16 · 09.30-18 · full-width digits and any dash (9–18) · an hour mark
//   or AM/PM word on a clock · 22-6+ or 22-30 (ends next day; 22-7 alone too when the day's plan crosses midnight)
//   9-18/90 or the break word + 1, 60, 1:30 (time away) · 9-12,13:30-18 (time away) · 7:52- (in only) · -18 (out only)
//   = (as scheduled; also remote work and training) · x (absent) · o (outside work) · business trip
//   day off, shift codes (D, S1 …) and leave words are read here; the save resolves them against the day's plan.
// Refused: +2 or 18+2 (overtime is only an approval record), status words (derived from times), a lone 8 or 8:00 (hours, not
// times), 0.375 (an Excel fraction), an ambiguous code, unconfirmed policy-long spans, 22-6 without the + off a night plan.
// A draft is checked here so the typist sees the refusal at once; the server's answer is the one that counts.
import type { Window } from "./minutes";

type Entry =
  | { kind: "TIMES"; spans: Window[] }
  | { kind: "CLOCK_IN_ONLY"; start: number }
  | { kind: "CLOCK_OUT_ONLY"; end: number }
  | { kind: "AS_SCHEDULED" }
  | { kind: "ABSENT" }
  | { kind: "OUTSIDE_WORK" }
  | { kind: "BUSINESS_TRIP" }
  | { kind: "DAY_OFF" }
  | { kind: "SHIFT"; code: string }
  | { kind: "LEAVE"; word: string };

export type ParseCode =
  | "overtime_typed"
  | "entry_unreadable"
  | "overnight_without_marker"
  | "span_too_long"
  | "spans_overlap"
  | "status_is_derived"
  | "hours_without_times"
  | "excel_fraction"
  | "code_ambiguous";
type Parsed = { ok: true; entry: Entry } | { ok: false; code: ParseCode; at?: number };
/** What the day's plan adds: a shift that crosses midnight lets a single span end the next day without the +. */
type Plan = { overnight: boolean };

// The Korean code words are input syntax, not copy: written as escapes so no Hangul sits outside the catalogs
// (the same words the server accepts, in records/grammar.rs).
const BREAK = "\u{d734}";
const HOUR = "\u{c2dc}";
const OVERTIME = "\u{c5f0}\u{c7a5}";
const ACTIVITIES = ["\u{c7ac}\u{d0dd}", "\u{ad50}\u{c721}"];
const words = (list: string[], read: (w: string) => Entry | ParseCode) => list.map((w) => [w, read(w)] as const);
const CODES = new Map<string, Entry | ParseCode>([
  ...words(["=", "\u{c18c}\u{c815}", "\u{c7ac}", ...ACTIVITIES], () => ({ kind: "AS_SCHEDULED" })),
  ...words(["x", "X", "\u{acb0}\u{adfc}", "\u{acb0}"], () => ({ kind: "ABSENT" })),
  ...words(["o", "O", "\u{c678}\u{adfc}", "\u{c678}"], () => ({ kind: "OUTSIDE_WORK" })),
  ...words(["\u{cd9c}\u{c7a5}"], () => ({ kind: "BUSINESS_TRIP" })),
  ...words([BREAK, "\u{d734}\u{bb34}", "OFF", "Off", "off"], () => ({ kind: "DAY_OFF" })),
  ...words(["\u{c8fc}", "\u{c57c}", "\u{be44}", "\u{b2f9}"], (code) => ({ kind: "SHIFT", code })),
  ...words(
    [
      "v", "V", "\u{d734}\u{ac00}", "\u{c5f0}", "\u{c5f0}\u{cc28}", "\u{bc18}", "\u{c624}\u{c804}\u{bc18}\u{cc28}",
      "\u{c624}\u{d6c4}\u{bc18}\u{cc28}", "\u{bc18}\u{bc18}", "\u{bcd1}", "\u{bcd1}\u{ac00}", "\u{acbd}\u{c870}", "\u{acf5}\u{ac00}",
      "\u{c608}\u{be44}\u{ad70}", "\u{bbfc}\u{bc29}\u{c704}", "\u{c0dd}\u{b9ac}", "\u{bb34}\u{ae09}",
    ],
    (word) => ({ kind: "LEAVE", word }),
  ),
  ...words(["\u{cd9c}"], () => "code_ambiguous"),
  ...words(["\u{c9c0}", "\u{c9c0}\u{ac01}", "\u{c870}", "\u{c870}\u{d1f4}"], () => "status_is_derived"),
]);

function codeOf(v: string): Entry | ParseCode | undefined {
  if (/^([DEN]|S\d{1,2})$/i.test(v)) return { kind: "SHIFT", code: v.toUpperCase() };
  if (v.startsWith(OVERTIME)) return "overtime_typed";
  return CODES.get(v);
}

const DASH = /[~\u{2010}-\u{2015}\u{2053}\u{2212}\u{223c}\u{301c}\u{3030}\u{fe58}\u{fe63}\u{ff0d}\u{ff5e}]/gu;
/** NFKC (full-width 18：00, decomposed Hangul), every dash as `-`, inner spaces collapsed. */
const normalise = (raw: string) => raw.normalize("NFKC").replace(DASH, "-").replace(/\s+/g, " ").trim();

const MERIDIEM = /^(\u{c624}\u{c804}|\u{c624}\u{d6c4}|am|pm)\s*/iu;
/**
 * `9`, `09`, `9:30`, `09.30`, `0930`, `9` + hour mark, with an optional AM/PM word → minutes; 24:00 only as 1440. A `late` end
 * (no AM/PM word) may run to 47:59, the next day in shift-sheet notation.
 */
function clock(raw: string, late = false): number | null {
  let s = raw.trim();
  const half = MERIDIEM.exec(s);
  if (half) s = s.slice(half[0].length);
  const pm = half ? /^(\u{c624}\u{d6c4}|pm)$/iu.test(half[1]!) : null;
  const whole = s.endsWith(HOUR);
  if (whole) s = s.slice(0, -1).trimEnd();
  const m = whole ? /^(\d{1,2})$/.exec(s) : (/^(\d{1,2})(?:[:.](\d{2}))?$/.exec(s) ?? /^(\d{2})(\d{2})$/.exec(s));
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] === undefined ? 0 : Number(m[2]);
  if (pm !== null) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (pm ? 12 : 0);
  }
  const t = h * 60 + min;
  return min < 60 && (t <= 1440 || (late && pm === null && t < 2880)) ? t : null;
}

/** The break word and its length at the end (9-18, break word, 1): under 10 counts hours, else minutes, or h:mm. Null when malformed. */
function breakSuffix(body: string): { body: string; away: number | null } | null {
  const i = body.lastIndexOf(BREAK);
  if (i < 0) return { body, away: null };
  let tail = body.slice(i + 1).trim();
  const plus = tail.endsWith("+");
  if (plus) tail = tail.slice(0, -1).trimEnd();
  const m = /^(\d{1,2})(?::(\d{2}))?$/.exec(tail);
  if (!m || (m[2] !== undefined && Number(m[2]) >= 60)) return null;
  const n = Number(m[1]);
  const away = m[2] === undefined ? (n < 10 ? n * 60 : n) : n * 60 + Number(m[2]);
  return { body: `${body.slice(0, i).trimEnd()}${plus ? "+" : ""}`, away };
}

const refuse = (code: ParseCode, at?: number): Parsed => ({ ok: false, code, at });
const TIME_CHAR = /[\d:\-,/+ .apm\u{c2dc}\u{d734}\u{c624}\u{c804}\u{d6c4}\u{c7ac}\u{d0dd}\u{ad50}\u{c721}]/iu;
/** The first character that is not part of a time (the console boxes it: 「6:5O-16」). */
const badAt = (v: string) => {
  const i = [...v].findIndex((c) => !TIME_CHAR.test(normalise(c) || " "));
  return i < 0 ? undefined : i;
};

export function parseEntry(raw: string, longSpanMinutes?: number, confirmed = false, plan?: Plan): Parsed {
  if (raw.length > 40 * 2 || [...raw].length > 40) return refuse("entry_unreadable");
  const v = normalise(raw);
  const coded = codeOf(v);
  if (coded !== undefined) return typeof coded === "string" ? refuse(coded) : { ok: true, entry: coded };
  const unreadable = () => refuse("entry_unreadable", badAt(raw.trim()));
  const activity = ACTIVITIES.find((w) => v.startsWith(w));
  const split = breakSuffix(activity ? v.slice(activity.length).trimStart() : v);
  if (!split) return unreadable();
  const nextDay = split.body.endsWith("+");
  const body = nextDay ? split.body.slice(0, -1).trimEnd() : split.body;
  if (body.includes("+")) return refuse("overtime_typed");
  if (/^0?\.\d+$/.test(body)) return refuse("excel_fraction");
  if (/^\d{1,2}\.\d+$/.test(body) || clock(body) !== null) return refuse("hours_without_times");
  if (body.startsWith("-")) {
    const end = nextDay || split.away !== null ? null : clock(body.slice(1));
    return end !== null && end > 0 ? { ok: true, entry: { kind: "CLOCK_OUT_ONLY", end } } : unreadable();
  }
  if (body.endsWith("-")) {
    const start = split.away === null ? clock(body.slice(0, -1)) : null;
    return start !== null && start < 1440 ? { ok: true, entry: { kind: "CLOCK_IN_ONLY", start } } : unreadable();
  }
  const [spansRaw, awayRaw, extra] = body.split("/");
  if (extra !== undefined || (awayRaw !== undefined && split.away !== null)) return unreadable();
  const away = awayRaw === undefined ? split.away : /^\d+$/.test(awayRaw.trim()) ? Number(awayRaw) : NaN;
  if (Number.isNaN(away)) return unreadable();
  const parts = spansRaw!.split(",");
  const wrap = nextDay || (plan?.overnight === true && parts.length === 1);
  const spans: Window[] = [];
  let shift = 0;
  for (const part of parts) {
    const [a, b, more] = part.split("-");
    if (b === undefined || more !== undefined) return unreadable();
    const s0 = clock(a!);
    const e0 = clock(b, !nextDay);
    if (s0 === null || e0 === null) return unreadable();
    let start = s0 + shift;
    let end = e0 + shift;
    const prev = spans.at(-1)?.end;
    if (prev !== undefined && start < prev && nextDay && shift === 0) {
      shift = 1440;
      start += 1440;
      end += 1440;
    }
    if (end <= start) {
      if (!wrap || end >= 1440) return refuse("overnight_without_marker");
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
 * A likely intended value for a refused one, offered as one fix chip (7:48-5:10 → 7:48-17:10, 22-07 → 22-07+): an afternoon
 * end typed in 12-hour form, a letter O typed for a zero, or a missing next-day +. Null when nothing plausible exists.
 */
export function suggestFix(raw: string): string | null {
  const v = normalise(raw);
  const zero = v.replace(/[oO]/g, "0");
  if (zero !== v && parseEntry(zero).ok) return zero;
  const m = /^(\d{1,2}(?::\d{2})?)\s*-\s*(\d{1,2})(:\d{2})?$/.exec(v);
  if (m && Number(m[2]) < 12) {
    const fix = `${m[1]}-${Number(m[2]) + 12}${m[3] ?? ""}`;
    if (parseEntry(fix).ok) return fix;
  }
  const p = parseEntry(v);
  return !p.ok && p.code === "overnight_without_marker" && parseEntry(`${v}+`).ok ? `${v}+` : null;
}
