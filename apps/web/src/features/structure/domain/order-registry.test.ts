import { describe, expect, test } from "vitest";
import type { OrgStructure, OrgStructureNode } from "@console/api/pending";
import { buildStructure } from "./model";
import { orderStep, orderVerdicts, placeAfter, reorderedByDrag } from "./rules";
import { registryCsv, registryRows } from "./registry";
import { expandedFor } from "./layout";
import { findHits } from "./search";

const n = (kind: OrgStructureNode["kind"], id: string, children: OrgStructureNode[] = [], extra: Partial<OrgStructureNode> = {}): OrgStructureNode =>
  ({ kind, id, name: id, headcount: 1, direct_headcount: 0, dispatched_headcount: 0, chips: [], version: 1, children, ...extra });
const tree: OrgStructure = {
  tenant_name: "T",
  phase: "SETUP",
  unplaced: [],
  entities: [
    n("LEGAL_ENTITY", "e1", [
      n("WORKPLACE", "w1", [n("DEPARTMENT", "d1", [], { head: { name: "Kim", concurrent: false } as never, code: "PT-1" }), n("DEPARTMENT", "d2")], { workplace_kind: "FACTORY" }),
      n("WORKPLACE", "w2"),
      n("WORKPLACE", "w3"),
    ], { direct_headcount: 3 }),
    n("LEGAL_ENTITY", "e2", [n("WORKPLACE", "w4", [n("DEPARTMENT", "d3", [], { chips: ["needs_confirmation"] })])]),
  ],
};
const s = buildStructure(tree, [], (code) => (code === "FACTORY" ? "공장" : undefined));
const at = (id: string) => s.byId.get(id)!;

describe("model extras", () => {
  test("a workplace carries its kind's label, a legal entity its 미배치", () => {
    expect(at("w1").siteKind).toBe("공장");
    expect(at("e1").unplaced).toBe(3);
    expect(at("e2").unplaced).toBeUndefined();
  });
  test("find matches a department's code", () => expect(findHits(s, "pt-1").ids).toEqual(["d1"]));
  test("people with no legal entity count in the tenant and are named on it", () => {
    const t = buildStructure({ ...tree, entity_unknown_headcount: 3 });
    expect(t.root.headcount).toBe(s.root.headcount + 3);
    expect(t.root.unplaced).toBe(3);
    expect(s.root.unplaced).toBeUndefined();
  });
});

test("depth: two department levels open the workplaces and their first departments only", () => {
  const deep = buildStructure({ ...tree, entities: [n("LEGAL_ENTITY", "e9", [n("WORKPLACE", "w9", [n("DEPARTMENT", "a", [n("DEPARTMENT", "b", [n("DEPARTMENT", "c")])])])])] });
  expect([...expandedFor(deep.root, "two")].sort()).toEqual(["a", "e9", "tenant", "w9"]);
  expect([...expandedFor(deep.root, "one")].sort()).toEqual(["e9", "tenant", "w9"]);
});

describe("order", () => {
  test("one place earlier or later among the same level's siblings, pinned to the order read, never past an end", () => {
    expect(orderStep(s, at("w2"), -1)).toEqual({ legal_entity_id: "e1", children: ["w2", "w1", "w3"], expected_children: ["w1", "w2", "w3"] });
    expect(orderStep(s, at("d2"), -1)).toEqual({ workplace_id: "w1", children: ["d2", "d1"], expected_children: ["d1", "d2"] });
    expect(orderStep(s, at("w1"), -1)).toBeUndefined();
    expect(orderStep(s, at("w3"), 1)).toBeUndefined();
    expect(orderStep(s, s.root, 1)).toBeUndefined();
  });
  test("legal entities order in the tenant: the request names no parent", () => {
    expect(orderStep(s, at("e1"), 1)).toEqual({ children: ["e2", "e1"], expected_children: ["e1", "e2"] });
    expect(orderStep(s, at("e1"), -1)).toBeUndefined();
  });
  test("a dragged workplace goes between its own legal entity's workplaces only, right after the target", () => {
    const v = orderVerdicts(s, at("w1"));
    expect(v.get("w3")).toEqual({ ok: true });
    expect(v.get("w1")).toEqual({ ok: false, reason: "here" });
    expect(v.get("w4")).toEqual({ ok: false, reason: "siteOtherEntity" });
    expect(v.get("d2")).toEqual({ ok: false, reason: "siteOrderOnly" });
    expect(placeAfter(s, at("w1"), at("w3"))).toEqual({ legal_entity_id: "e1", children: ["w2", "w3", "w1"], expected_children: ["w1", "w2", "w3"] });
    expect(placeAfter(s, at("w3"), at("w1"))).toEqual({ legal_entity_id: "e1", children: ["w1", "w3", "w2"], expected_children: ["w1", "w2", "w3"] });
  });
  test("a dragged legal entity goes between the other legal entities only", () => {
    expect([s.root, at("e1"), at("w1"), at("d1")].map(reorderedByDrag)).toEqual([false, true, true, false]);
    const v = orderVerdicts(s, at("e2"));
    expect(v.get("e1")).toEqual({ ok: true });
    expect(v.get("w1")).toEqual({ ok: false, reason: "entityOrderOnly" });
    expect(v.get("tenant")).toEqual({ ok: false, reason: "entityOrderOnly" });
    expect(placeAfter(s, at("e1"), at("e2"))).toEqual({ children: ["e2", "e1"], expected_children: ["e1", "e2"] });
  });
});

describe("registry", () => {
  const closed = new Set<string>();
  test("a filter keeps each match with the path to it", () => {
    const ids = (f: ("vacant" | "todo")[]) => registryRows(s, { level: "all", q: "", filters: new Set(f), closed }).map((r) => r.id);
    expect(ids(["todo"])).toEqual(["e1", "e2", "w4", "d3"]);
    expect(ids(["vacant"])).toEqual(["e1", "w1", "d2", "e2", "w4", "d3"]);
    expect(registryRows(s, { level: "dept", q: "", filters: new Set(["vacant"]), closed }).map((r) => r.id)).toEqual(["d2", "d3"]);
  });
  test("folded rows hide their children unless a find or filter reaches below", () => {
    expect(registryRows(s, { level: "all", q: "", filters: new Set(), closed: new Set(["e1"]) }).map((r) => r.id)).toEqual(["e1", "e2", "w4", "d3"]);
    expect(registryRows(s, { level: "all", q: "d1", filters: new Set(), closed: new Set(["e1"]) }).map((r) => r.id)).toEqual(["e1", "w1", "d1"]);
  });
  test("the org sheet: a BOM, quoted cells where needed, one row per unit", () => {
    const dated = { ...s, asOf: "2026-09-01", knownAt: "2026-09-15T12:00:00+09:00" };
    const csv = registryCsv(dated, [at("d1")], ["level", "entity", "site", "dept", "code", "head", "people", "as_of", "known_at"], () => "부서");
    expect(csv).toBe("﻿level,entity,site,dept,code,head,people,as_of,known_at\r\n부서,e1,w1,d1,PT-1,Kim,1,2026-09-01,2026-09-15T12:00:00+09:00\r\n");
  });
});
