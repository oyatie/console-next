import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { baseOf, draftState, fill, fillSchedule, ledgerParts, readPaste, type CellFacts } from "./grid";

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
  const r = readPaste("20047\t06:54-16:06\t=\n99999\t9-18\n20007\t06:40-16:00\n", numbers, { r: 0, c: 5 });
  expect(r.matched).toBe(2);
  expect(r.missing).toEqual(["99999"]);
  expect(r.cells).toEqual([
    { r: 1, c: 5, value: "06:54-16:06" },
    { r: 1, c: 6, value: "=" },
    { r: 0, c: 5, value: "06:40-16:00" },
  ]);
  const one = readPaste("9-18\t9-18", numbers, { r: 2, c: 0 });
  expect(one.cells).toEqual([{ r: 2, c: 0, value: "9-18" }, { r: 2, c: 1, value: "9-18" }]);
  expect(readPaste("9-18\n9-18", numbers, { r: 0, c: 0 }).needsNumber).toBe(true);
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
