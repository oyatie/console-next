import { expect, test } from "vitest";
import type { OrgStructure, OrgStructureNode } from "@console/api/pending";
import { buildStructure } from "./model";
import { expandedFor, layout } from "./layout";

const node = (kind: OrgStructureNode["kind"], id: string, children: OrgStructureNode[] = []): OrgStructureNode => ({
  kind, id, name: id, headcount: 0, direct_headcount: 0, dispatched_headcount: 0, chips: [], version: 1, children,
});
const tree = (children: OrgStructureNode[]): OrgStructure => ({
  tenant_name: "T", phase: "SETUP", unplaced: [],
  entities: [node("LEGAL_ENTITY", "entity", [node("WORKPLACE", "site", [node("DEPARTMENT", "dept", children)])])],
});

test.each(["tenant", "dept"])("the add input stays before newly read children with %s in focus", (focusId) => {
  const positions = [[], [node("DEPARTMENT", "new")], [node("DEPARTMENT", "new"), node("DEPARTMENT", "next")]].map((children) => {
    const s = buildStructure(tree(children));
    const focus = s.byId.get(focusId)!;
    const l = layout({ s, focus, expanded: expandedFor(focus, "all"), ghostUnder: "dept" });
    const input = l.boxes.find((b) => b.ghost)!;
    const added = l.boxes.find((b) => b.node.id === "new");
    if (added) expect(focusId === "dept" ? input.x < added.x : input.y < added.y).toBe(true);
    return { x: input.x, y: input.y, w: input.w, h: input.h };
  });
  expect(positions[1]).toEqual(positions[0]);
  expect(positions[2]).toEqual(positions[0]);
});
