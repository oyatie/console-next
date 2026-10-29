import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { baseOf, draftState, fill, fillSchedule, ledgerParts, readPaste, type CellFacts, type PasteRefusal } from "./grid";

const { drafts: fixtureDrafts } = JSON.parse(readFileSync(new URL("../../../../../../scripts/fixtures/attendance-grammar-cases.json", import.meta.url), "utf8")) as {
  drafts: { plan_kinds: string[]; cases: { raw: string[]; expect: string; by_plan?: Record<string, string> }[] };
};

test.each(fixtureDrafts.plan_kinds.flatMap((planKind) => fixtureDrafts.cases.flatMap((c) => c.raw.map((value) => ({
  planKind, value, expected: c.by_plan?.[planKind] ?? c.expect,
})))))("$planKind + $value agrees with the server: $expected", ({ planKind, value, expected }) => {
  const state = draftState({ value, base: null }, planKind);
  expect(state.ok ? "ok" : state.code).toBe(expected);
});

const cell = (key: string, planKind: string, entryId: string | null = null, own = false): CellFacts => ({ key, planKind, entryId, own, closed: false });
const october = Array.from({ length: 31 }, (_, i) => `2026-10-${String(i + 1).padStart(2, "0")}`);

test.each(["=", "\u{d734}"])("first paste %s before the plan loads defers to the server", (value) => {
  expect(draftState({ value, base: null }, undefined)).toEqual({ ok: true });
});

test("an existing draft follows schedule assignment and removal without being retyped", () => {
  const draft = fill([cell("a|1", "NO_SCHEDULE")], "=", {}).drafts["a|1"]!;
  expect(draftState(draft, "NO_SCHEDULE")).toMatchObject({ ok: false, code: "no_shift_to_copy" });
  expect(draftState(draft, "WORK")).toEqual({ ok: true });
  expect(draftState(draft, "REST_DAY")).toMatchObject({ ok: false, code: "no_shift_to_copy" });
  expect(draftState(draft, undefined)).toEqual({ ok: true });
  expect(draft).toEqual({ value: "=", base: null });
});

test("a persisted plan snapshot cannot override the current day", () => {
  const draft = { value: "\u{d734}", base: "entry", planKind: "WORK" };
  expect(draftState(draft, "REST_DAY")).toMatchObject({ ok: false, code: "already_day_off" });
  expect(draftState(draft, "WORK")).toMatchObject({ ok: false, code: "schedule_change_needed" });
  expect(draftState(draft, undefined)).toEqual({ ok: true });
});

test.each([
  ["-18", "clock_out_only_not_stored"],
  ["\u{c5f0}\u{cc28}", "leave_not_stored"],
  ["D", "schedule_change_needed"],
])("draft %s refuses with preview's %s", (value, code) => {
  expect(draftState({ value, base: null }, undefined)).toMatchObject({ ok: false, code });
});

test("fill as scheduled drafts only empty work days and counts every skip", () => {
  const cells = [cell("a|1", "WORK"), cell("a|2", "WEEKLY_HOLIDAY"), cell("b|1", "WORK", "e1"), cell("c|1", "WORK", null, true), cell("d|1", "WORK")];
  const r = fillSchedule(cells, {});
  expect(r.filled).toBe(2);
  expect(r.skipped).toEqual({ rest: 1, recorded: 1, locked: 1, unscheduled: 0 });
  expect(r.drafts["a|1"]).toEqual({ value: "=", base: null });
});

test("fill as scheduled distinguishes unscheduled people from rest days and locked rows", () => {
  const r = fillSchedule([cell("scheduled|1", "WORK"), cell("unscheduled|1", "NO_SCHEDULE"), cell("rest|1", "REST_DAY")], {});
  expect(r.drafts).toEqual({ "scheduled|1": { value: "=", base: null } });
  expect(r.filled).toBe(1);
  expect(r.skipped).toEqual({ rest: 1, recorded: 0, locked: 0, unscheduled: 1 });
});

test("one value fills a selection with each cell's base, skipping the own row", () => {
  const r = fill([cell("a|1", "WORK", "e1"), cell("c|1", "WORK", null, true)], "9-18", {});
  expect(r.drafts).toEqual({ "a|1": { value: "9-18", base: "e1" } });
  expect(r.skipped).toBe(1);
  expect(draftState({ value: "+2", base: null }, undefined)).toEqual({ ok: false, code: "overtime_typed", at: undefined });
});

test("a multi-row paste matches by employee number and names the misses", () => {
  const numbers = ["20007", "20047", null];
  const r = readPaste("20047\t06:54-16:06\t=\n99999\t9-18\n20007\t06:40-16:00\n", numbers, october, { r: 0, c: 5 });
  expect(r.matched).toBe(2);
  expect(r.missing).toEqual(["99999"]);
  expect(r.cells).toEqual([
    { r: 1, c: 5, date: october[5]!, value: "06:54-16:06" },
    { r: 1, c: 6, date: october[6]!, value: "=" },
    { r: 0, c: 5, date: october[5]!, value: "06:40-16:00" },
  ]);
  const one = readPaste("9-18\t9-18", numbers, october, { r: 2, c: 0 });
  expect(one.cells).toEqual([{ r: 2, c: 0, date: october[0]!, value: "9-18" }, { r: 2, c: 1, date: october[1]!, value: "9-18" }]);
  expect(readPaste("9-18\n9-18", numbers, october, { r: 0, c: 0 }).refusal).toBe("employeeNumberRequired");
});

test("the common employee-name plus numbered-day matrix keeps day 1 under day 1", () => {
  const header = ["사번", "성명", ...Array.from({ length: 31 }, (_, i) => String(i + 1))].join("\t");
  const row = ["20007", "홍길동", "09:00-18:00", "08:00-17:00", ...Array(29).fill("")].join("\t");
  const paste = readPaste(`${header}\n${row}`, ["20007"], october, { r: 0, c: 0 });
  expect(paste.cells).toEqual([
    { r: 0, c: 0, date: "2026-10-01", value: "09:00-18:00" },
    { r: 0, c: 1, date: "2026-10-02", value: "08:00-17:00" },
  ]);
});

test("a matrix without a name column still maps days and ignores total columns", () => {
  const paste = readPaste("사번\t1(목)\t2(금)\t근무일수\t연장\n20007\t09:00-18:00\t08:00-17:00\t21\t4", ["20007"], october, { r: 0, c: 12 });
  expect(paste.cells).toEqual([
    { r: 0, c: 0, date: "2026-10-01", value: "09:00-18:00" },
    { r: 0, c: 1, date: "2026-10-02", value: "08:00-17:00" },
  ]);
  expect(paste.ignoredColumns).toEqual(["근무일수", "연장"]);
});

test("a title and second weekday header are consumed before data rows", () => {
  const paste = readPaste([
    "2026년 10월 근태현황",
    "사번\t성명\t1\t2\t근무일수",
    "\t\t목\t금\t",
    "20007\t홍길동\t09-18\t08-17\t21",
  ].join("\n"), ["20007"], october, { r: 0, c: 0 });
  expect(paste.cells).toEqual([
    { r: 0, c: 0, date: "2026-10-01", value: "09-18" },
    { r: 0, c: 1, date: "2026-10-02", value: "08-17" },
  ]);
});

test("name and department columns are display context while 사번 can appear anywhere", () => {
  const paste = readPaste("부서\t성명\t사번\t1\n인사\t홍길동\t20007\t09-18", ["20007"], october, { r: 0, c: 10 });
  expect(paste.cells).toEqual([{ r: 0, c: 0, date: "2026-10-01", value: "09-18" }]);
  expect(paste.identities).toEqual([{ r: 0, name: "홍길동", department: "인사" }]);
});

test("a name-only matrix refuses to match employees by name", () => {
  const paste = readPaste("성명\t1\n홍길동\t09-18", ["20007"], october, { r: 0, c: 0 });
  expect(paste.refusal).toBe("employeeNumberHeader");
  expect(paste.cells).toEqual([]);
});

test("two explicitly labelled 출근/퇴근 rows merge by employee and day", () => {
  const paste = readPaste([
    ["사번", "성명", "구분", "1", "2"].join("\t"),
    ["20007", "홍길동", "출근", "09:00", "08:30"].join("\t"),
    ["", "", "퇴근", "18:00", "17:30"].join("\t"),
    ["20047", "김길동", "출근", "09:10", "08:40"].join("\t"),
    ["", "", "퇴근", "18:10", "17:40"].join("\t"),
  ].join("\n"), ["20007", "20047"], october, { r: 0, c: 0 });
  expect(paste.cells).toEqual([
    { r: 0, c: 0, date: "2026-10-01", value: "09:00-18:00" },
    { r: 0, c: 1, date: "2026-10-02", value: "08:30-17:30" },
    { r: 1, c: 0, date: "2026-10-01", value: "09:10-18:10" },
    { r: 1, c: 1, date: "2026-10-02", value: "08:40-17:40" },
  ]);
  expect(paste.refusal).toBeNull();
});

test("a partial month paste maps its numbered columns even when out of order and away from focus", () => {
  const paste = readPaste("사번\t15\t1\t3\n20007\t12-20\t09-18\t10-19", ["20007"], october, { r: 0, c: 9 });
  expect(paste.cells).toEqual([
    { r: 0, c: 14, date: "2026-10-15", value: "12-20" },
    { r: 0, c: 0, date: "2026-10-01", value: "09-18" },
    { r: 0, c: 2, date: "2026-10-03", value: "10-19" },
  ]);
});

test("an unlabelled continuation row is refused instead of dropping the second line", () => {
  const paste = readPaste("사번\t성명\t1\n20007\t홍길동\t09:00\n\t\t18:00", ["20007"], october, { r: 0, c: 0 });
  expect(paste.refusal).toBe("unlabelledMultiRow");
  expect(paste.cells).toEqual([]);
});

test("the as-is headerless two-row shape never silently drops clock-outs", () => {
  const paste = readPaste("MW-0001\t09:00\t09:10\n\t18:00\t18:30\nMW-0002\t09:00\t08:55\n\t18:00\t19:00", ["MW-0001", "MW-0002"], october, { r: 0, c: 0 });
  expect(paste.refusal).toBe("unlabelledMultiRow");
  expect(paste.cells).toEqual([]);
});

test.each<{ shape: string; text: string; refusal: PasteRefusal; c?: number }>([
  { shape: "name-only header", text: "성명\t1\n홍길동\t9-18", refusal: "employeeNumberHeader" },
  { shape: "missing employee before labelled rows", text: "사번\t구분\t1\n\t출근\t09:00", refusal: "employeeNumberRequired" },
  { shape: "missing employee in a plain row", text: "사번\t1\n\t9-18", refusal: "employeeNumberRequired" },
  { shape: "no day header", text: "사번\t성명\n20007\t홍길동", refusal: "dayHeaderRequired" },
  { shape: "wrong title month", text: "2026년 9월 근태현황\n사번\t1\n20007\t9-18", refusal: "wrongMonth" },
  { shape: "wrong dated header month", text: "사번\t2026-09-01\n20007\t9-18", refusal: "wrongMonth" },
  { shape: "wrong dated header beside a valid day", text: "사번\t1\t2026-09-15\n20007\t9-18\t10-19", refusal: "wrongMonth" },
  { shape: "day beyond month", text: "사번\t32\n20007\t9-18", refusal: "dayOutsideMonth" },
  { shape: "duplicate day aliases", text: "사번\t1\t2026-10-01\n20007\t9-18\t10-19", refusal: "duplicateDay" },
  { shape: "three rows including overtime", text: "사번\t구분\t1\n20007\t출근\t09:00\n\t퇴근\t18:00\n\t연장\t2", refusal: "unsupportedRowType" },
  { shape: "duplicate clock-in rows", text: "사번\t구분\t1\n20007\t출근\t09:00\n\t출근\t10:00", refusal: "unsupportedRowType" },
  { shape: "clock-out without clock-in", text: "사번\t구분\t1\n20007\t퇴근\t18:00", refusal: "clockOutOnly" },
  { shape: "plain and paired rows mixed", text: "사번\t구분\t1\n20007\t\t9-18\n\t출근\t09:00\n\t퇴근\t18:00", refusal: "unlabelledMultiRow" },
  { shape: "duplicate positional destination", text: "20007\t9-18\n20007\t10-19", refusal: "unlabelledMultiRow" },
  { shape: "single-row positional overflow", text: "9-18\t10-19", c: 30, refusal: "dayOutsideMonth" },
  { shape: "employee-row positional overflow", text: "20007\t9-18\t10-19", c: 30, refusal: "dayOutsideMonth" },
  { shape: "empty clipboard", text: "\t\n", refusal: "noCells" },
  { shape: "empty matrix", text: "사번\t1\n20007\t", refusal: "noCells" },
])("refuses $shape with $refusal and no partial writes", ({ text, refusal, c = 0 }) => {
  const paste = readPaste(text, ["20007"], october, { r: 0, c });
  expect(paste.refusal).toBe(refusal);
  expect(paste.cells).toEqual([]);
});

test("the day ledger's parts add up to the people in scope", () => {
  const l = { people: 10, no_schedule: 1, rest: 2, no_record: 1, missing_out: 0, absent: 0, outside: 1, trip: 0, late_or_early: 1, normal: 4, pending: 0 };
  expect(ledgerParts(l).adds).toBe(true);
  expect(ledgerParts({ ...l, normal: 3 }).adds).toBe(false);
});

// Regression (silent overwrite): a draft's base was re-read from the live row on every keystroke or fill, so a change
// another HR worker saved while it was being typed became the base and the save overwrote it without a 409.
test("a draft keeps the version seen when it began; only a new draft takes the version on screen", () => {
  const drafts = { "a|1": { value: "9-17", base: "e1" }, "b|1": { value: "=", base: null } };
  expect(baseOf(drafts, "a|1", "e2")).toBe("e1");
  expect(baseOf(drafts, "b|1", "e9")).toBeNull();
  expect(baseOf(drafts, "c|1", "e3")).toBe("e3");
  const r = fill([cell("a|1", "WORK", "e2"), cell("c|1", "WORK", "e3")], "9-18", drafts);
  expect(r.drafts["a|1"]).toEqual({ value: "9-18", base: "e1" });
  expect(r.drafts["c|1"]).toEqual({ value: "9-18", base: "e3" });
});

test("fill reads each destination's plan when copying a day-off word", () => {
  const cells = [cell("a|1", "WORK"), cell("a|2", "WEEKLY_HOLIDAY"), cell("a|3", "NO_SCHEDULE")];
  const result = fill(cells, "\u{d734}", {});
  expect(cells.map((c) => draftState(result.drafts[c.key]!, c.planKind))).toEqual([
    { ok: false, code: "schedule_change_needed", at: undefined },
    { ok: false, code: "already_day_off", at: undefined },
    { ok: false, code: "schedule_change_needed", at: undefined },
  ]);
});
