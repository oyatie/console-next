import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { parseEntry, recordedMinutes, suggestFix } from "./grammar";

// The one table both parsers run (backend records/grammar_tests.rs reads the same file): a draft and the save must agree.
type Case = { raw: string; expect: string; long?: number; confirmed?: boolean; overnight?: boolean; as_is?: boolean };
const fixture = JSON.parse(readFileSync(new URL("../../../../../../scripts/fixtures/attendance-grammar-cases.json", import.meta.url), "utf8")) as {
  as_is_tokens: number;
  as_is_refused: number;
  cases: Case[];
};

const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const show = (c: Case) => {
  const p = parseEntry(c.raw, c.long ?? 960, c.confirmed ?? false, { overnight: c.overnight ?? false });
  if (!p.ok) return `refused ${p.code}`;
  const e = p.entry;
  switch (e.kind) {
    case "TIMES": return `TIMES ${e.spans.map((w) => `${hhmm(w.start)}-${hhmm(w.end)}`).join(",")}`;
    case "CLOCK_IN_ONLY": return `CLOCK_IN_ONLY ${hhmm(e.start)}`;
    case "CLOCK_OUT_ONLY": return `CLOCK_OUT_ONLY ${hhmm(e.end)}`;
    case "SHIFT": return `SHIFT ${e.code}`;
    case "LEAVE": return `LEAVE ${e.word}`;
    default: return e.kind;
  }
};

test("every fixture case reads as the shared table says", () => {
  const wrong = fixture.cases.map((c) => [c.raw, show(c), c.expect]).filter(([, got, want]) => got !== want);
  expect(wrong).toEqual([]);
});

test("the as-is token set refuses only the designed residue", () => {
  const asIs = fixture.cases.filter((c) => c.as_is);
  expect(asIs).toHaveLength(fixture.as_is_tokens);
  expect(asIs.filter((c) => show(c).startsWith("refused ")).length).toBe(fixture.as_is_refused);
});

test("the wrong character is located and a fix is offered", () => {
  expect(parseEntry("6:5O-16")).toMatchObject({ ok: false, at: 3 });
  expect(parseEntry("\u{c7ac}\u{d0dd} 9-1x")).toMatchObject({ ok: false, code: "entry_unreadable", at: 6 });
  expect(suggestFix("6:5O-16")).toBe("6:50-16");
  expect(suggestFix("7:48-5:10")).toBe("7:48-17:10");
  expect(suggestFix("9\u{2013}2")).toBe("9-14");
  expect(suggestFix("22-07")).toBe("22-07+");
  expect(suggestFix("+2")).toBeNull();
  expect(suggestFix("\u{c9c0}\u{ac01}")).toBeNull();
});

test("recorded minutes of a draft", () => {
  const p = parseEntry("9-12,13-18");
  expect(p.ok && recordedMinutes(p.entry)).toBe(480);
  const out = parseEntry("-18");
  expect(out.ok && recordedMinutes(out.entry)).toBe(0);
});

test("every minute round-trips and acknowledgement changes only the threshold guard", () => {
  const clock = (m: number) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
  for (const start of [0, 300, 540, 1320, 1439]) for (let duration = 1; duration <= 1440; duration += 1) {
    const end = start + duration;
    const raw = `${clock(start)}-${clock(end > 1440 ? end - 1440 : end)}${end > 1440 ? "+" : ""}`;
    const yes = parseEntry(raw, 960, true);
    expect(yes).toEqual({ ok: true, entry: { kind: "TIMES", spans: [{ start, end }] } });
    const no = parseEntry(raw, 960);
    expect(no.ok ? "ok" : no.code).toBe(duration > 960 ? "span_too_long" : "ok");
  }
});
