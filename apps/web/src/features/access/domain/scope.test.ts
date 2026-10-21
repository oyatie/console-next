import { expect, test } from "vitest";
import { filterRows, flatten, nodeScope, offered, reach, sameScope, type KindRule, type OrgNode } from "./scope";

const n = (kind: OrgNode["kind"], id: string, name: string, headcount: number, children: OrgNode[] = []): OrgNode => ({ kind, id, name, headcount, children });
const TREE = [
  n("LEGAL_ENTITY", "e1", "(주)새온", 10, [n("WORKPLACE", "w1", "본사", 10, [n("DEPARTMENT", "d1", "인사팀", 3), n("DEPARTMENT", "d2", "영업팀", 4, [n("TEAM", "t1", "영업1파트", 2)])])]),
  n("LEGAL_ENTITY", "e2", "(주)새온물류", 5, [n("WORKPLACE", "w2", "공장2", 5)]),
];
const PILOT: KindRule[] = [
  { kind: "TENANT", enforceable: true, descendants_only: true },
  { kind: "LEGAL_ENTITY", enforceable: true, descendants_only: true },
  { kind: "WORKPLACE", enforceable: true, descendants_only: true },
  { kind: "DEPARTMENT", enforceable: false, descendants_only: true },
];

test("reach: the tenant total, a node with units below, or the node alone", () => {
  expect(reach(TREE, { kind: "TENANT", include_descendants: true })).toBe(15);
  expect(reach(TREE, { kind: "WORKPLACE", node_id: "w1", include_descendants: true })).toBe(10);
  expect(reach(TREE, { kind: "WORKPLACE", node_id: "w1", include_descendants: false })).toBe(3);
  expect(reach(TREE, { kind: "DEPARTMENT", node_id: "d2", include_descendants: false })).toBe(2);
  expect(reach(TREE, { kind: "LEGAL_ENTITY", node_id: "gone", include_descendants: true })).toBeNull();
});

test("the pilot offers 법인 and 사업장 only, each with the units below; a refused kind is never listed", () => {
  const cut = offered(TREE, PILOT);
  expect(flatten(cut).map((r) => r.node.id)).toEqual(["e1", "w1", "e2", "w2"]);
  expect(nodeScope(TREE[0]!.children[0]!)).toEqual({ kind: "WORKPLACE", node_id: "w1", include_descendants: true });
  expect(flatten(offered(TREE, PILOT.map((r) => ({ ...r, enforceable: true })))).map((r) => r.node.id)).toContain("t1");
  expect(sameScope({ kind: "TENANT", include_descendants: true }, { kind: "TENANT", node_id: null, include_descendants: true })).toBe(true);
});

test("search keeps each hit with the path that leads to it, and nothing else", () => {
  const rows = flatten(TREE);
  expect(filterRows(rows, "파트").map((r) => r.node.id)).toEqual(["e1", "w1", "d2", "t1"]);
  expect(filterRows(rows, "공장").map((r) => r.node.id)).toEqual(["e2", "w2"]);
  expect(filterRows(rows, " ")).toHaveLength(rows.length);
  expect(rows.find((r) => r.node.id === "t1")!.path).toEqual(["(주)새온", "본사", "영업팀"]);
});

test("AX-5 (governance-22): a 부서 subtree is offered once the catalog marks it enforceable", () => {
  const ax5 = PILOT.map((r) => ({ ...r, enforceable: true }));
  expect(flatten(offered(TREE, ax5)).map((r) => r.node.id)).toEqual(["e1", "w1", "d1", "d2", "t1", "e2", "w2"]);
  expect(nodeScope(TREE[0]!.children[0]!.children[1]!)).toEqual({ kind: "DEPARTMENT", node_id: "d2", include_descendants: true });
});

test("regression (company-21): a closed 법인 or 사업장, and everything under it, is never offered as a scope", () => {
  const ax5 = PILOT.map((r) => ({ ...r, enforceable: true }));
  const closed = [TREE[0]!, { ...TREE[1]!, chips: ["closed"] }];
  expect(flatten(offered(closed, ax5)).map((r) => r.node.id)).not.toContain("e2");
  const shut = [{ ...TREE[0]!, children: [{ ...TREE[0]!.children[0]!, chips: ["closed"] }] }];
  expect(flatten(offered(shut, ax5)).map((r) => r.node.id)).toEqual(["e1"]);
});
