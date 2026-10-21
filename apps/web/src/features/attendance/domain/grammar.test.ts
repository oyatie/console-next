import { expect, test } from "vitest";
import { parseEntry, recordedMinutes, suggestFix } from "./grammar";

// The same table as the server's records/grammar_tests.rs: a draft and the save must agree.
const spans = (v: string) => {
  const p = parseEntry(v);
  if (!p.ok || p.entry.kind !== "TIMES") throw new Error(`${v}: ${JSON.stringify(p)}`);
  return p.entry.spans.map((w) => [w.start, w.end]);
};

test("the spec table reads as spans", () => {
  for (const v of ["9-18", "0900-1800", "09:00~18:00", " 9 - 18 "]) expect(spans(v), v).toEqual([[540, 1080]]);
  expect(spans("9:30-18:15")).toEqual([[570, 1095]]);
  expect(spans("6:50-16")).toEqual([[410, 960]]);
  expect(spans("22-6+")).toEqual([[1320, 1800]]);
  expect(spans("9-12,13:30-18")).toEqual([[540, 720], [810, 1080]]);
  expect(spans("9-18/90")).toEqual([[540, 765], [855, 1080]]);
  expect(spans("21-24")).toEqual([[1260, 1440]]);
});

test("codes and clock-in only", () => {
  expect(parseEntry("=")).toEqual({ ok: true, entry: { kind: "AS_SCHEDULED" } });
  expect(parseEntry("소정")).toEqual({ ok: true, entry: { kind: "AS_SCHEDULED" } });
  expect(parseEntry("x")).toEqual({ ok: true, entry: { kind: "ABSENT" } });
  expect(parseEntry("결근")).toEqual({ ok: true, entry: { kind: "ABSENT" } });
  expect(parseEntry("o")).toEqual({ ok: true, entry: { kind: "OUTSIDE_WORK" } });
  expect(parseEntry("출장")).toEqual({ ok: true, entry: { kind: "BUSINESS_TRIP" } });
  expect(parseEntry("7:52-")).toEqual({ ok: true, entry: { kind: "CLOCK_IN_ONLY", start: 472 } });
});

test("refusals name their reason", () => {
  const cases: [string, string][] = [
    ["+2", "overtime_typed"],
    ["18+2", "overtime_typed"],
    ["9-18+2", "overtime_typed"],
    ["6:5O-16", "entry_unreadable"],
    ["7:48-5:10", "overnight_without_marker"],
    ["22-6", "overnight_without_marker"],
    ["9-13,12-18", "spans_overlap"],
    ["", "entry_unreadable"],
    ["9:7-18", "entry_unreadable"],
    ["25-26", "entry_unreadable"],
    ["9-18/600", "entry_unreadable"],
    ["9-18/0", "entry_unreadable"],
    ["3~4/59", "entry_unreadable"],
  ];
  for (const [v, code] of cases) {
    const p = parseEntry(v);
    expect(p.ok ? "ok" : p.code, v).toBe(code);
  }
});

test("the wrong character is located and a fix is offered", () => {
  expect(parseEntry("6:5O-16")).toMatchObject({ ok: false, at: 3 });
  expect(suggestFix("6:5O-16")).toBe("6:50-16");
  expect(suggestFix("7:48-5:10")).toBe("7:48-17:10");
  expect(suggestFix("+2")).toBeNull();
});

test("recorded minutes of a draft", () => {
  const p = parseEntry("9-12,13-18");
  expect(p.ok && recordedMinutes(p.entry)).toBe(480);
});

test("long spans require confirmation against effective policy, preserving input guards", () => {
  for (const raw of ["5-23", "5-12,13-23", "22-15+", "22-24,1-15+"]) {
    expect(parseEntry(raw, 960)).toMatchObject({ ok: false, code: "span_too_long" });
    expect(parseEntry(raw, 960, true).ok).toBe(true);
  }
  expect(parseEntry("5-21", 960).ok).toBe(true);
  expect(parseEntry("5-21:01", 960)).toMatchObject({ ok: false, code: "span_too_long" });
  expect(parseEntry("5-23", 1080).ok).toBe(true);
  expect(parseEntry("9-18", 480)).toMatchObject({ ok: false, code: "span_too_long" });
  expect(parseEntry("9-13,12-18", 960, true)).toMatchObject({ ok: false, code: "spans_overlap" });
  expect(parseEntry("22-6", 960, true)).toMatchObject({ ok: false, code: "overnight_without_marker" });
  for (const raw of ["constructor", "__proto__", "24-6+", "5-23/2000", "9".repeat(41)]) expect(parseEntry(raw, 960, true)).toMatchObject({ ok: false, code: "entry_unreadable" });
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

test("fuzz regressions: breaks and midnight never create empty spans", () => {
  for (const raw of ["3~4/59", "0~1,1~9,9~10,10~11,24-0+", "9-18,24-0+"]) expect(parseEntry(raw, 1440, true)).toMatchObject({ ok: false, code: "entry_unreadable" });
  expect(spans("3~4/58")).toEqual([[180, 181], [239, 240]]);
});
