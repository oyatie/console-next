import { expect, test } from "vitest";
import type { components } from "@console/api/schema";
import { preview, type PreviewNode } from "./preview";

type Unit = components["schemas"]["OrgUnitHead"];
const u = (id: string, kind: Unit["kind"], parentId: string | null, headcount = 0, status: Unit["status"] = "ACTIVE"): Unit =>
  ({ id, kind, name: id, parentId, status, effectiveFrom: "2026-01-01", headcount, updatedAt: "2026-01-01T00:00:00Z" });
const units = [u("co", "COMPANY", null, 99), u("hq", "SITE", "co"), u("hr", "DEPARTMENT", "hq", 1), u("ops", "DEPARTMENT", "hq", 4), u("rec", "TEAM", "hr", 2), u("old", "TEAM", "hr", 5, "DISSOLVED")];
const line = (n: PreviewNode) => `${n.id}:${n.count}${n.mark ? `:${n.mark}` : ""}${n.delta ? `:${n.delta > 0 ? "+" : ""}${n.delta}` : ""}`;
const show = (ns: PreviewNode[]) => ns.map((n) => [line(n), n.children.map(line)]);

test("create: the parent with its children, the new unit marked; dissolved units stay out", () => {
  const p = preview(units, { op: "CREATE_ORG_UNIT", kind: "TEAM", parentId: "hr", name: "edu" });
  expect(show(p.before)).toEqual([["hr:3", ["rec:2"]]]);
  expect(show(p.after)).toEqual([["hr:3", ["rec:2", "new:0:0:created"]]]);
});

test("move: both parents, the roll-up follows the moved unit", () => {
  const p = preview(units, { op: "MOVE_ORG_UNIT", orgUnitId: "rec", parentId: "ops" });
  expect(show(p.before)).toEqual([["hr:3", ["rec:2"]], ["ops:4", []]]);
  expect(show(p.after)).toEqual([["hr:1", []], ["ops:6", ["rec:2:moved"]]]);
});

test("dissolve keeps the unit in view, marked; a site's parent is the company root", () => {
  expect(show(preview(units, { op: "DISSOLVE_ORG_UNIT", orgUnitId: "rec" }).after)).toEqual([["hr:1", ["rec:2:dissolved"]]]);
  expect(show(preview(units, { op: "RENAME_ORG_UNIT", orgUnitId: "hq", name: "HQ" }).after)[0]![1]).toEqual(["hq:7:renamed"]);
});

test("reassign: the two units alone, with −n and +n", () => {
  const p = preview(units, { op: "REASSIGN_ORG_UNIT", fromOrgUnit: "rec", toOrgUnit: "ops", scope: { company: "co" } });
  expect(show(p.after)).toEqual([["rec:0:-2", []], ["ops:6:+2", []]]);
});

test("reassign up into the parent: the parent's roll-up stays, the chips still say who moves", () => {
  const p = preview(units, { op: "REASSIGN_ORG_UNIT", fromOrgUnit: "rec", toOrgUnit: "hr", scope: { company: "co" } });
  expect(show(p.after)).toEqual([["rec:0:-2", []], ["hr:3:+2", []]]);
});
