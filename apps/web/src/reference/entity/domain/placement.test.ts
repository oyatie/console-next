import { expect, test } from "vitest";
import { entityOfUnit, placementOfUnit, withinEntity } from "./placement";

const n = (kind: string, id: string, children: unknown[] = []) => ({ kind, id, name: id, headcount: 0, chips: [], children }) as never;
const tree = [n("LEGAL_ENTITY", "e1", [n("WORKPLACE", "w1", [n("DEPARTMENT", "d1", [n("TEAM", "t1")])]), n("WORKPLACE", "w2")]), n("LEGAL_ENTITY", "e2", [n("DEPARTMENT", "span")])];

test("a unit's employer and workplace come from where it sits in the tree", () => {
  expect(placementOfUnit(tree, "t1")).toEqual({ entityId: "e1", workplaceId: "w1" });
  expect(placementOfUnit(tree, "span")).toBeNull(); // spans the entity's workplaces: the workplace is asked
  expect(placementOfUnit(tree, "nope")).toBeNull();
});

test("same-named workplaces resolve their own unit by ID in each legal entity", () => {
  const workplace = (id: string, unit: string) => ({ kind: "WORKPLACE", id, name: "본사", org_unit_id: unit, headcount: 0, chips: [], children: [] });
  const roots = [n("LEGAL_ENTITY", "e1", [workplace("w1", "s1")]), n("LEGAL_ENTITY", "e2", [workplace("w2", "s2")])];
  expect(placementOfUnit(roots, "s1")).toEqual({ entityId: "e1", workplaceId: "w1" });
  expect(placementOfUnit(roots, "s2")).toEqual({ entityId: "e2", workplaceId: "w2" });
});

test("regression: a transfer target in another legal entity is never within the person's (TR-33, move walk M22)", () => {
  const site = n("WORKPLACE", "w3", [n("DEPARTMENT", "plan")]);
  (site as { org_unit_id?: string }).org_unit_id = "site-unit";
  const group = [...tree, n("LEGAL_ENTITY", "e3", [site])];
  expect(entityOfUnit(group, "t1")).toBe("e1");
  expect(entityOfUnit(group, "site-unit")).toBe("e3"); // the workplace's own unit
  expect(withinEntity(group, "plan", "e1")).toBe(false);
  expect(withinEntity(group, "site-unit", "e1")).toBe(false);
  expect(withinEntity(group, "d1", "e1")).toBe(true);
  expect(withinEntity(group, "nope", "e1")).toBe(true); // not placed: the server judges it
  expect(withinEntity(group, "plan", null)).toBe(true); // no 법인 recorded: nothing to compare
});
