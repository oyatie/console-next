import { expect, test } from "vitest";
import { buildTree, pathTo, type TreeNode } from "./tree";

const n = (kind: TreeNode["kind"], id: string, parent: string | null, name: string): TreeNode => ({ kind, id, parent_id: parent, name, people: 1 });
const nodes = [
  n("LEGAL_ENTITY", "le", null, "(주)새온정밀"),
  n("WORKPLACE", "wp", "le", "평택공장"),
  n("DEPARTMENT", "d1", "wp", "생산1팀"),
  n("DEPARTMENT", "d2", "wp", "설비보전팀"),
  n("CREW", "c1", "wp", "평택 교대 A조"),
  n("WORKPLACE", "wp2", "out-of-scope", "이천물류센터"),
];

test("the whole tree, a node outside the caller's scope becoming a root", () => {
  const t = buildTree(nodes);
  expect(t.roots.map((r) => r.id)).toEqual(["le", "wp2"]);
  expect(t.childrenOf(t.byId.get("wp")!).map((c) => c.id)).toEqual(["d1", "d2", "c1"]);
});

test("a search keeps the matches and the way to them", () => {
  const t = buildTree(nodes, "설비");
  expect(t.roots.map((r) => r.id)).toEqual(["le"]);
  expect(t.childrenOf(t.byId.get("wp")!).map((c) => c.id)).toEqual(["d2"]);
  expect(buildTree(nodes, "없는 이름").roots).toEqual([]);
});

test("the path from the root opens the tree to a node", () => {
  expect(pathTo(buildTree(nodes).byId, "d2")).toEqual(["le", "wp", "d2"]);
});
