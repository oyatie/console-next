import { expect, test } from "vitest";
import { childrenOf, currentName, EMPTY, targetOf, fieldsOf, firstOfNextMonth, nextMonday, namesakes, reassignTargets, validate, type Unit } from "./proposal";

const u = (id: string, kind: Unit["kind"], parentId: string | null, extra: Partial<Unit> = {}): Unit =>
  ({ id, kind, name: id, parentId, status: "ACTIVE", effectiveFrom: "2026-01-01", headcount: 0, updatedAt: "2026-01-01T00:00:00Z", ...extra });
// co › hq(site) › hr(dept) › rec(team) › sub(team); hq › ops(dept); old(team) dissolved under hr
const units = [
  u("co", "COMPANY", null),
  u("hq", "SITE", "co"),
  u("hr", "DEPARTMENT", "hq"),
  u("ops", "DEPARTMENT", "hq"),
  u("rec", "TEAM", "hr", { headcount: 2 }),
  u("sub", "TEAM", "rec"),
  u("old", "TEAM", "hr", { status: "DISSOLVED" }),
];
const at = (id: string) => units.find((x) => x.id === id)!;

test("each intent asks for its own inputs, then the date and the reason", () => {
  expect(fieldsOf({ kind: "create", parent: at("hr"), child: "TEAM" })).toEqual(["name", "date", "reason"]);
  expect(fieldsOf({ kind: "move", unit: at("rec") })).toEqual(["parent", "date", "reason"]);
  expect(fieldsOf({ kind: "dissolve", unit: at("rec") })).toEqual(["date", "reason"]);
});

test("validation: required after trimming, an unchanged rename, and no date before today", () => {
  const today = "2026-10-02";
  expect(validate(["name", "date", "reason"], { ...EMPTY, name: "  " }, { today })).toEqual({ name: "required", date: "required", reason: "required" });
  expect(validate(["name"], { ...EMPTY, name: " 채용팀 " }, { today, current: "채용팀" })).toEqual({ name: "unchanged" });
  expect(validate(["date"], { ...EMPTY, date: "2026-10-01" }, { today })).toEqual({ date: "beforeToday" });
  expect(validate(["date", "reason"], { ...EMPTY, date: today, reason: "x" }, { today })).toEqual({});
});

test("namesakes ignore case and outer spaces", () => {
  expect(namesakes(" Recruiting ", [{ name: "recruiting" }, { name: "Ops" }])).toEqual([{ name: "recruiting" }]);
  expect(namesakes("", [{ name: "" }])).toEqual([]);
});

test("children are the active units right under a unit; a site without a parent sits under the company", () => {
  expect(childrenOf(units, "hr").map((x) => x.id)).toEqual(["rec"]);
  expect(childrenOf([...units, u("site2", "SITE", null)], "co").map((x) => x.id)).toEqual(["hq", "site2"]);
});

test("reassign targets leave out the company, the unit itself and units being dissolved", () => {
  const { options, excluded } = reassignTargets(units, at("rec"), new Set(["ops"]));
  expect(options.map((x) => x.id)).toEqual(["hq", "hr", "sub"]);
  expect(excluded.map((x) => x.id)).toEqual(["ops"]);
});

test("date presets: next month's 1st (across the year end) and the next Monday, never today", () => {
  expect([firstOfNextMonth("2026-10-02"), firstOfNextMonth("2026-12-31")]).toEqual(["2026-11-01", "2027-01-01"]);
  expect([nextMonday("2026-10-02"), nextMonday("2026-10-05"), nextMonday("2026-10-04")]).toEqual(["2026-10-05", "2026-10-12", "2026-10-05"]);
});

test("the URL's act opens a proposal only for what is there and allowed", () => {
  const where = { units };
  expect(targetOf("create", "hr", undefined, where)).toMatchObject({ kind: "create", child: "DEPARTMENT" });
  expect(targetOf("create", "hr", "SITE", where)).toBeNull(); // a site never sits under a department
  expect(targetOf("create", "co", "SITE", where)).toBeNull(); // a 사업장 is added through its 법인, never proposed (MR-20)
  expect(targetOf("create", "co", undefined, where)).toBeNull(); // nothing is created under the company
  expect(targetOf("dissolve", "old", undefined, where)).toBeNull(); // already dissolved
  expect(targetOf("rename", "co", undefined, where)).toBeNull(); // the company is not an org unit
  expect(targetOf("region-close", "rec", undefined, where)).toBeNull(); // regions and branches are retired (MR-20)
});

// Edges the mutation run found unpinned (npm run mutants).

test("every intent kind asks for its inputs; a rename starts from the current name", () => {
  expect(fieldsOf({ kind: "rename", unit: at("rec") })).toEqual(["name", "date", "reason"]);
  expect(fieldsOf({ kind: "reassign", unit: at("rec"), members: {} as never })).toEqual(["to", "date", "reason"]);
  expect(currentName({ kind: "rename", unit: at("rec") })).toBe("rec");
  expect(currentName({ kind: "move", unit: at("rec") })).toBeUndefined();
});

test("'unchanged' is only for a name with a current one; 'beforeToday' only for the date", () => {
  const today = "2026-10-02";
  expect(validate(["name"], { ...EMPTY, name: "채용팀" }, { today, current: " 채용팀 " })).toEqual({ name: "unchanged" });
  expect(validate(["name"], { ...EMPTY, name: "채용팀" }, { today })).toEqual({});
  expect(validate(["name"], { ...EMPTY, name: "인재팀" }, { today, current: "채용팀" })).toEqual({});
  expect(validate(["reason"], { ...EMPTY, reason: "채용팀" }, { today, current: "채용팀" })).toEqual({});
  expect(validate(["reason"], { ...EMPTY, reason: "2000-01-01" }, { today })).toEqual({});
});

test("the company is the root wherever it sits in the list", () => {
  expect(childrenOf([u("hq", "SITE", null), u("co", "COMPANY", null)], "co").map((x) => x.id)).toEqual(["hq"]);
  expect(childrenOf([u("hr", "DEPARTMENT", "hq")], "hq").map((x) => x.id)).toEqual(["hr"]);
});

test("the URL's act on member moves and moves", () => {
  const where = { units };
  expect(targetOf("reassign", "rec", undefined, where)).toEqual({ kind: "reassign", unit: at("rec") });
  expect(targetOf("move", "rec", undefined, where)).toEqual({ kind: "move", unit: at("rec") });
  expect(targetOf("branch-create", "rec", undefined, where)).toBeNull();
  expect(targetOf("create", "nope", "TEAM", where)).toBeNull();
  expect(targetOf("create", "co", "COMPANY", where)).toBeNull();
  expect(targetOf(undefined, "rec", undefined, where)).toBeNull();
});
