import { expect, test } from "vitest";
import { endPresets, endToWire, grantOp, lastDay, missing, ready, type DraftLine } from "./grants";

const TODAY = "2026-10-06";
const scope = { kind: "LEGAL_ENTITY", node_id: "e1", include_descendants: true } as const;
const line = (o: Partial<DraftLine>): DraftLine => ({ key: "a", role_id: null, scope: null, end: null, ...o });

test("end chips run to the day before the 3-, 6- and 12-month mark", () => {
  expect(endPresets(TODAY)).toEqual([
    { id: "m3", date: "2027-01-05" },
    { id: "m6", date: "2027-04-05" },
    { id: "y1", date: "2027-10-05" },
  ]);
});

test("the shown last day and the exclusive wire end round-trip; an open stored end reads as none", () => {
  expect(endToWire("2027-10-05")).toBe("2027-10-06T00:00:00+09:00");
  expect(lastDay("2027-10-06T00:00:00+09:00")).toBe("2027-10-05");
  expect(lastDay("2027-10-05T15:00:00Z")).toBe("2027-10-05"); // KST midnight written in UTC
  expect(lastDay(null)).toBeNull();
});

test("a line names every field it still needs, a past end and a repeated role over one scope", () => {
  expect(missing(line({}), [], TODAY)).toEqual(["role", "scope", "end"]);
  expect(missing(line({ role_id: "r", scope, end: "2026-10-05" }), [], TODAY)).toEqual(["end_past"]);
  expect(missing(line({ role_id: "r", scope, end: TODAY }), [], TODAY)).toEqual([]);
  const a = line({ role_id: "r", scope, end: "2027-01-05" });
  const b = { ...a, key: "b" };
  expect(missing(a, [a, b], TODAY)).toEqual(["duplicate"]);
  expect(missing(a, [a, { ...b, scope: { kind: "TENANT", include_descendants: true } }], TODAY)).toEqual([]);
  expect(ready(a)).toBe(true);
  expect(ready(line({ role_id: "r" }))).toBe(false);
  expect(grantOp("acc", { role_id: "r", scope, end: "2027-01-05" }, false)).toEqual({ op: "grant", account_id: "acc", role_id: "r", scope, valid_to: "2027-01-06T00:00:00+09:00", effective_in_setup: false });
});

test("ROL-M4-grant-op: an operating grant can start on a later day (KST midnight); without one it starts on save", () => {
  const l = { role_id: "r", scope, end: "2027-10-05" };
  expect(grantOp("a", l, false, "2026-11-01")).toMatchObject({ valid_from: "2026-11-01T00:00:00+09:00", valid_to: "2027-10-06T00:00:00+09:00" });
  expect(grantOp("a", l, false)).not.toHaveProperty("valid_from");
});
