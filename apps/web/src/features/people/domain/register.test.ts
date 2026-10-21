import { expect, test } from "vitest";
import { resolvePlace, workplaceChoices } from "./register-place";
import { EMPTY, gaps, isCarried, nextPerson, type Draft } from "./register";

const full: Draft = { ...EMPTY, name: "임하람", birth: "1999.11.03", where: "unit", unitId: "u1", hire: "2026-10-12", type: "REGULAR", phone: "010-1234-5678", position: "사원", pay: "3000000" };

test("an empty draft lacks everything required, in page order; nothing is preselected", () => {
  expect(gaps(EMPTY, false)).toEqual(["name", "hire"]);
  expect(gaps(full, true)).toEqual([]);
});

test("typed values that are not one block too: a birth date the calendar has not got, a manual number left blank", () => {
  expect(gaps({ ...full, birth: "1999-13-01" }, true)).toEqual(["birth"]);
  expect(gaps({ ...full, numberMode: "manual" }, true)).toEqual(["number"]);
  expect(gaps({ ...full, unitId: "" }, true)).toEqual(["unit"]);
  expect(gaps({ ...full, type: "CONTRACT" }, true)).toEqual([]);
  expect(gaps({ ...full, contractEnd: "2026-10-11" }, true)).toEqual(["contractEnd"]);
  expect(gaps({ ...full, phone: "010-12" }, false)).toEqual(["phone"]);
});

test("only name and hire date are needed; absent placement and explicit unplaced are valid", () => {
  const minimum = { ...EMPTY, name: "가", hire: "2026-10-06" };
  expect(gaps(minimum, false)).toEqual([]);
  expect(gaps({ ...minimum, where: "none" }, false, false)).toEqual([]);
});

test("the next person starts empty unless a value is carried", () => {
  expect(nextPerson(full, new Set())).toEqual(EMPTY);
  expect(nextPerson(full, new Set(["place", "hire"] as const))).toEqual({ ...EMPTY, where: "unit", unitId: "u1", hire: "2026-10-12" });
});

test("a unit with no workplace of its own asks for one; the unit's own workplace and branch win when there is one", () => {
  const filled = { ...EMPTY, name: "가", unitId: "u1", hire: "2026-10-06", type: "REGULAR" as const, position: "사원", pay: "1" };
  expect(gaps(filled, true, false)).toEqual(["workplace"]);
  expect(gaps(filled, true, true)).toEqual([]);
  const entities = [{ id: "e1", current: { name: "한결" }, workplaces: [{ id: "w1", default_branch_id: "b1", current: { name: "본점" } }, { id: "w2", default_branch_id: null, current: { name: "공장" } }] }] as never;
  const unit = { unit: { id: "u1" }, entity: "", entityId: null, workplaceId: null, site: "" } as never;
  expect(resolvePlace(unit, entities, "")).toMatchObject({ own: false, branchId: null });
  expect(resolvePlace(unit, entities, "w1")).toMatchObject({ own: false, entityId: "e1", workplaceId: "w1", branchId: "b1", entity: "한결" });
  expect(resolvePlace({ ...(unit as object), workplaceId: "w1" } as never, entities, "w9")).toMatchObject({ own: true, branchId: "b1" });
  expect(workplaceChoices(entities).map((w) => w.workplaceId)).toEqual(["w1"]);
});

test("연속 등록 carries only what is switched on, never the person's own facts; an edited carried value is no longer marked", () => {
  const next = nextPerson(full, new Set(["place", "type", "position", "pay"] as const));
  expect(next).toEqual({ ...EMPTY, where: "unit", unitId: "u1", type: "REGULAR", position: "사원", pay: "3000000" });
  expect([next.name, next.birth, next.phone, next.hire]).toEqual(["", "", "", ""]);
  const on = new Set(["place", "position"] as const);
  expect(isCarried(next, full, "place", on)).toBe(true);
  expect(isCarried({ ...next, position: "대리" }, full, "position", on)).toBe(false);
  // Switched off, or the first person of the run: nothing reads as carried.
  expect(isCarried(next, full, "type", on)).toBe(false);
  expect(isCarried(next, null, "place", on)).toBe(false);
});
