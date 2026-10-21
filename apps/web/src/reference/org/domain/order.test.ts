import { expect, test } from "vitest";
import type { StructureNode } from "@console/api/pending";
import { moved, orderOf } from "./order";

const n = (id: string, kind: StructureNode["kind"], children: StructureNode[] = []): StructureNode => ({ kind, id, name: id, headcount: 0, direct_headcount: 0, dispatched_headcount: 0, chips: [], children });

test("a sibling moves one place; the ends stay put; the list keeps every child once", () => {
  expect(moved(["a", "b", "c"], "b", -1)).toEqual(["b", "a", "c"]);
  expect(moved(["a", "b", "c"], "b", 1)).toEqual(["a", "c", "b"]);
  expect(moved(["a", "b", "c"], "a", -1)).toEqual(["a", "b", "c"]);
  expect(moved(["a", "b", "c"], "c", 1)).toEqual(["a", "b", "c"]);
  expect(moved(["a", "b"], "x", 1)).toEqual(["a", "b"]);
});

test("the parent a reorder names, and only the children of the kind it orders", () => {
  expect(orderOf(n("e", "LEGAL_ENTITY", [n("w1", "WORKPLACE"), n("w2", "WORKPLACE")]), "WORKPLACE")).toEqual({ parent: { legal_entity_id: "e" }, ids: ["w1", "w2"] });
  expect(orderOf(n("w", "WORKPLACE", [n("d1", "DEPARTMENT"), n("d2", "DEPARTMENT")]), "DEPARTMENT")).toEqual({ parent: { workplace_id: "w" }, ids: ["d1", "d2"] });
  expect(orderOf(n("d", "DEPARTMENT", [n("s", "DEPARTMENT")]), "DEPARTMENT")).toEqual({ parent: { org_unit_id: "d" }, ids: ["s"] });
});
