import { expect, test } from "vitest";
import { rolledUp, scopeQuery, scopeRows } from "./scope";

const units = [
  { id: "c", kind: "COMPANY", name: "새온", parentId: null, status: "ACTIVE", headcount: 30 },
  { id: "s", kind: "SITE", name: "평택공장", parentId: "c", status: "ACTIVE", headcount: 0 },
  { id: "d", kind: "DEPARTMENT", name: "생산부", parentId: "s", status: "ACTIVE", headcount: 1 },
  { id: "t", kind: "DEPARTMENT", name: "생산1팀", parentId: "d", status: "ACTIVE", headcount: 8 },
  { id: "x", kind: "DEPARTMENT", name: "폐지팀", parentId: "d", status: "DISSOLVED", headcount: 0 },
];
const entities = [{ id: "e", name: "새온정밀", workplaces: [{ id: "w1", name: "서울 본사" }, { id: "w2", name: "평택공장", orgUnitId: "s" }] }];

test("a scope travels in one param and asks the matching filter", () => {
  expect(scopeQuery(undefined)).toEqual({});
  expect(scopeQuery("le:e")).toEqual({ legal_entity_id: "e" });
  expect(scopeQuery("wp:w2")).toEqual({ workplace_id: "w2" });
  expect(scopeQuery("t")).toEqual({ org_unit_id: "t" });
});

test("a 부서 counts everything under it; dissolved units drop out", () => {
  expect(rolledUp(units, "d")).toBe(9);
  const rows = scopeRows(entities, units, [{ value: "e", count: 31 }], [{ value: "w2", count: 16 }]);
  expect(rows.map((r) => [r.value, r.depth, r.count])).toEqual([["le:e", 0, 31], ["wp:w1", 1, 0], ["wp:w2", 1, 16], ["d", 2, 9], ["t", 3, 8]]);
  expect(rows[0]!.meta).toEqual({ sites: 2, units: 2 });
});

test("a search keeps a match with its ancestors only", () => {
  expect(scopeRows(entities, units, [], [], "1팀").map((r) => r.name)).toEqual(["새온정밀", "평택공장", "생산1팀"]);
  expect(scopeRows(entities, units, [], [], "없음")).toEqual([]);
});

test("same-named workplaces show only departments under their bound unit", () => {
  const same = [{ id: "e1", name: "A", workplaces: [{ id: "w1", name: "본사", orgUnitId: "s" }] }, { id: "e2", name: "B", workplaces: [{ id: "w2", name: "본사", orgUnitId: "s2" }] }];
  const all = [...units, { ...units[1]!, id: "s2", name: "본사" }, { ...units[2]!, id: "d2", parentId: "s2", name: "개발부" }];
  expect(scopeRows(same, all, [], []).map((r) => r.value)).toEqual(["le:e1", "wp:w1", "d", "t", "le:e2", "wp:w2", "d2"]);
});
