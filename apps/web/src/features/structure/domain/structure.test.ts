import { describe, expect, test } from "vitest";
import type { LegalEntity, OrgStructure, OrgStructureNode } from "@console/api/pending";
import { buildStructure, pathTo, siteDirect } from "./model";
import { collapseSelection, nameClash, verdicts } from "./rules";
import { expandedFor, isFar, layout, W } from "./layout";
import { findHits } from "./search";

const n = (kind: OrgStructureNode["kind"], id: string, headcount: number, children: OrgStructureNode[] = []): OrgStructureNode => ({ kind, id, name: id, headcount, direct_headcount: 0, dispatched_headcount: 0, chips: [], version: 1, children });
const tree = (sites = 2): OrgStructure => ({
  tenant_name: "T",
  phase: "SETUP",
  unplaced: [],
  entities: [
    n("LEGAL_ENTITY", "e1", 30, [
      n("WORKPLACE", "w1", 20, [n("DEPARTMENT", "d1", 15, [n("DEPARTMENT", "d11", 5)]), n("DEPARTMENT", "d2", 3)]),
      ...Array.from({ length: sites - 1 }, (_, i) => n("WORKPLACE", `wx${i}`, 1)),
    ]),
    n("LEGAL_ENTITY", "e2", 4, [n("WORKPLACE", "w2", 4, [n("DEPARTMENT", "d3", 4)])]),
  ],
});

describe("model", () => {
  const s = buildStructure(tree());
  test("rolls the tenant up and links every node to its 법인 and 사업장", () => {
    expect(s.root.headcount).toBe(34);
    expect(s.byId.get("d11")).toMatchObject({ entityId: "e1", siteId: "w1", parentId: "d1", depth: 4 });
    expect(s.counts).toEqual({ entities: 2, sites: 3, depts: 4 });
    expect(pathTo(s, "d11").map((x) => x.id)).toEqual(["tenant", "e1", "w1", "d1", "d11"]);
  });
  test("사업장 직속 is the roll-up less its 부서", () => expect(siteDirect(s.byId.get("w1")!)).toBe(2));
  test("the card keeps the same full business registration number as the entity", () => {
    const entity = { id: "e1", names: [], workplaces: [], registrations: [{ holder_workplace_id: "w1", brn: { value: "0000000000", display: "000-00-00000" } }], primary_workplace_id: "w1" } as unknown as LegalEntity;
    expect(buildStructure(tree(), [entity]).byId.get("e1")?.brn).toBe("000-00-00000");
  });
});

describe("rules", () => {
  const s = buildStructure(tree());
  const v = verdicts(s, [s.byId.get("d1")!]);
  test("a 부서 drops onto a 사업장 or 부서 of its own 법인 only", () => {
    expect(v.get("d2")).toEqual({ ok: true });
    expect(v.get("wx0")).toEqual({ ok: true });
    expect(v.get("d11")).toEqual({ ok: false, reason: "ownSubtree" });
    expect(v.get("d1")).toEqual({ ok: false, reason: "ownSubtree" });
    expect(v.get("e1")).toEqual({ ok: false, reason: "entityOnlySites" });
    expect(v.get("d3")).toEqual({ ok: false, reason: "deptOtherEntity" });
    expect(v.get("w1")).toEqual({ ok: false, reason: "here" });
  });
  test("a selected descendant folds into its selected ancestor", () => {
    const c = collapseSelection(s, new Set(["d11", "d1", "d2"]));
    expect(c.top.map((x) => x.id)).toEqual(["d1", "d2"]);
    expect(c.folded.map((x) => x.id)).toEqual(["d11"]);
  });
  test("names clash among siblings after NFC and trim", () => expect(nameClash(s.byId.get("w1")!, " d2 ")?.id).toBe("d2"));
});

describe("layout", () => {
  test("the tenant is near with few 법인; children of the focus sit in a row, deeper levels stack", () => {
    const s = buildStructure(tree());
    const L = layout({ s, focus: s.root, expanded: expandedFor(s.root, "sites") });
    expect(L.lod).toBe("near");
    const [e1, e2] = ["e1", "e2"].map((id) => L.boxes.find((b) => b.node.id === id)!);
    expect(e1!.y).toBe(e2!.y);
    expect(e1!.w).toBe(W.entity);
    const w1 = L.boxes.find((b) => b.node.id === "w1")!;
    expect(w1.x).toBeGreaterThan(e1!.x);
    expect(w1.more).toBe(3);
    expect(L.boxes.some((b) => b.node.id === "d1")).toBe(false);
  });
  test("above 8 사업장 the tenant view goes far and wraps them into tiles", () => {
    const s = buildStructure(tree(10));
    expect(isFar(s, s.root)).toBe(true);
    const L = layout({ s, focus: s.root, expanded: expandedFor(s.root, "sites") });
    expect(L.boxes.find((b) => b.node.id === "w1")).toMatchObject({ lod: "tile", w: W.tile });
  });
  test("an add box takes a slot under its parent", () => {
    const s = buildStructure(tree());
    const L = layout({ s, focus: s.byId.get("e1")!, expanded: expandedFor(s.byId.get("e1")!, "one"), ghostUnder: "w1" });
    const ghost = L.boxes.find((b) => b.ghost)!;
    const last = L.boxes.find((b) => b.node.id === "d2")!;
    expect(ghost.y).toBeLessThan(last.y);
  });
});

describe("search", () => {
  const s = buildStructure(tree());
  test("matches names case-insensitively and counts hits per 법인", () => {
    const h = findHits(s, "D1");
    expect(h.ids).toEqual(["d1", "d11"]);
    expect(h.perEntity.get("e1")).toBe(2);
  });
});

describe("search by registration number", () => {
  test("three or more digits match the 법인 or 사업장 holding the number", () => {
    const s = buildStructure(tree());
    s.byId.get("e1")!.brnKey = "0000000000";
    expect(findHits(s, "000-00").ids).toEqual(["e1"]);
    expect(findHits(s, "22").ids).toEqual([]);
  });
});

describe("toolbar spot", () => {
  test("a reserved viewport clips the above spot, so the toolbar opens on a visible side", async () => {
    const { toolsSpot } = await import("./layout");
    const b = { node: {} as never, lod: "m" as const, x: 400, y: 200, w: 256, h: 56 };
    const L = { boxes: [b], lines: [], w: 1000, h: 1000, lod: "near" as const };
    expect(toolsSpot(L, b, 1, undefined, undefined, { x: 0, y: 180, w: 1000, h: 500 })).toBe("below");
    expect(toolsSpot(L, b, 1, undefined, undefined, { x: 400, y: 200, w: 256, h: 56 })).toBe("inside");
  });
  test("above when clear, else a side that covers no box", async () => {
    const { toolsSpot } = await import("./layout");
    const b = { node: {} as never, lod: "m" as const, x: 400, y: 200, w: 192, h: 56 };
    expect(toolsSpot({ boxes: [b], lines: [], w: 1000, h: 1000, lod: "near" }, b)).toBe("above");
    const over = { ...b, x: 380, y: 150, h: 40 };
    expect(toolsSpot({ boxes: [b, over], lines: [], w: 1000, h: 1000, lod: "near" }, b)).toBe("below");
  });
  // Regression: a box at the stage's left edge drew its toolbar to the left, cut off by the canvas.
  test("never past the stage's edge", async () => {
    const { toolsSpot } = await import("./layout");
    const b = { node: {} as never, lod: "m" as const, x: 40, y: 40, w: 192, h: 56 };
    const below = { ...b, y: 110 };
    expect(toolsSpot({ boxes: [b, below], lines: [], w: 1000, h: 1000, lod: "near" }, b)).toBe("right");
  });
  // Regression: zoomed out, the toolbar is scaled back up to its target size and covered the next box over.
  test("allows for the toolbar scaled back up on a zoomed-out chart", async () => {
    const { toolsSpot } = await import("./layout");
    const b = { node: {} as never, lod: "m" as const, x: 600, y: 200, w: 192, h: 56 };
    const near = { ...b, x: 330, y: 140, w: 100, h: 40 };
    const L = { boxes: [b, near], lines: [], w: 1000, h: 1000, lod: "near" as const };
    expect(toolsSpot(L, b)).toBe("above");
    expect(toolsSpot(L, b, 1.4)).not.toBe("above");
  });
  // Regression: a tight stack hid the only mouse entry for adding another child.
  test("falls back to its own corner when no outside side is clear", async () => {
    const { toolsSpot } = await import("./layout");
    const b = { node: {} as never, lod: "m" as const, x: 300, y: 300, w: 192, h: 56 };
    const ring = [{ ...b, y: 234 }, { ...b, y: 366 }, { ...b, x: 500 }, { ...b, x: 100 }];
    const L = { boxes: [b, ...ring], lines: [], w: 1000, h: 1000, lod: "near" as const };
    expect(toolsSpot(L, b)).toBe("inside");
    expect(toolsSpot(L, b, 1.4)).toBe("inside");
  });
});

// Regression: the first-workplace slot was wider than the 사업장 box that replaces it, so its 법인 moved when it landed.
test("a 법인 with no 사업장 draws its slot as wide as the 사업장 that will replace it", () => {
  const s = buildStructure({ tenant_name: "T", phase: "SETUP", unplaced: [], entities: [n("LEGAL_ENTITY", "e1", 0)] });
  const slot = layout({ s, focus: s.root, expanded: new Set([s.root.id, "e1"]) }).boxes.find((b) => b.slot);
  expect(slot?.w).toBe(W.site);
});
