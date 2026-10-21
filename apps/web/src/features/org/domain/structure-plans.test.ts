import { describe, expect, test } from "vitest";
import type { Structure, StructureNode } from "@console/api/pending";
import { bulkPlan } from "./bulk-move";
import { deletePlan, mergePlan } from "./structure-plans";
import { dissolvePlan, scopedGrants } from "./dissolve-plan";
import { collapse, direct, locate, placesOf, targetsFor } from "../../../reference/org/domain/structure";

const dept = (id: string, name: string, headcount: number, children: StructureNode[] = []): StructureNode => ({ kind: "DEPARTMENT", id, name, version: 1, headcount, direct_headcount: 0, dispatched_headcount: 0, chips: [], children });
const wp = (id: string, name: string, headcount: number, children: StructureNode[]): StructureNode => ({ kind: "WORKPLACE", id, org_unit_id: `${id}-unit`, name, headcount, direct_headcount: 0, dispatched_headcount: 0, chips: [], children });
// 평택공장 322 = 품질관리부 38 (수입검사팀 14 + 공정품질팀 18 + 6 direct) + 설비보전팀 31 + 생산관리팀 9 + 244 직속.
const qa = dept("qa", "품질관리부", 38, [dept("in", "수입검사팀", 14), dept("pq", "공정품질팀", 18)]);
const pt = wp("pt", "평택공장", 322, [qa, dept("eq", "설비보전팀", 31), dept("pm", "생산관리팀", 9)]);
const as = wp("as", "아산공장", 172, [dept("qt", "품질팀", 15), dept("am", "생산관리팀", 6)]);
const other = wp("ot", "부산", 5, [dept("x", "영업팀", 5)]);
const s: Structure = {
  tenant_name: "새온그룹",
  phase: "SETUP",
  entities: [
    { kind: "LEGAL_ENTITY", id: "e1", name: "(주)새온정밀", headcount: 494, direct_headcount: 0, dispatched_headcount: 0, chips: [], children: [pt, as] },
    { kind: "LEGAL_ENTITY", id: "e2", name: "(주)새온물류", headcount: 5, direct_headcount: 0, dispatched_headcount: 0, chips: [], children: [other] },
  ],
  unplaced: [],
};
const places = placesOf(s);
const at = (id: string) => places.get(id)!;
const ei = (id: string) => id; // each 사업장 reports its own 고용보험

describe("tree", () => {
  test("direct counts and lookups", () => {
    expect(direct(qa)).toBe(6);
    expect(direct(pt)).toBe(244);
    expect(locate(places, "pt-unit")?.kind).toBe("workplace");
    expect(at("in").path).toEqual(["(주)새온정밀", "평택공장", "품질관리부"]);
  });
  test("a chosen 부서 inside another chosen one travels with it; targets stay in one 법인", () => {
    expect(collapse(places, ["qa", "pq", "eq"])).toEqual({ roots: [qa, at("eq").node], carried: [at("pq").node] });
    expect(targetsFor(places, [qa]).excluded).toEqual(new Set(["qa", "in", "pq"]));
    expect(targetsFor(places, [qa, at("x").node]).entity).toBeUndefined();
  });
});

describe("delete", () => {
  test("raising the sub-부서 moves them up before the dissolve; the members asked are the direct ones", () => {
    const p = deletePlan(at("qa"), "raise");
    expect(p.ops.map((o) => [o.op, o.org_unit_id, o.workplace_id])).toEqual([["MOVE", "in", "pt"], ["MOVE", "pq", "pt"], ["DISSOLVE", "qa", undefined]]);
    expect(p.asked).toEqual({ children: true, members: 6 });
    expect(p.after?.children.map((c) => [c.name, c.tag])).toEqual([["수입검사팀", "raised"], ["공정품질팀", "raised"], ["설비보전팀", undefined], ["생산관리팀", undefined]]);
  });
  test("cascading asks for everyone below; nothing is drawn after until it is chosen", () => {
    expect(deletePlan(at("qa"), "cascade").asked.members).toBe(38);
    expect(deletePlan(at("qa"), null).after).toBeUndefined();
  });
});

describe("폐지 after 운영 시작 (org-06)", () => {
  const people = [{ employeeId: "p1", name: "정영업" }, { employeeId: "p2", name: "김영업" }];
  const base = { place: at("qa"), members: people, to: at("pm").node, overrides: new Map(), grants: [], choices: new Map(), company: "새온그룹", date: "2026-10-07", today: "2026-10-07", workplaceOf: (n: StructureNode) => places.get(n.id)?.workplace?.id };
  test("one change: sub-부서 up, everyone to one place, then it closes (regression: two changes, one destination)", () => {
    const p = dissolvePlan(base);
    expect(p.ops.map((o) => o.op)).toEqual(["MOVE_ORG_UNIT", "MOVE_ORG_UNIT", "REASSIGN_ORG_UNIT", "DISSOLVE_ORG_UNIT"]);
    expect(p.ops[2]).toEqual({ op: "REASSIGN_ORG_UNIT", fromOrgUnit: "qa", toOrgUnit: "pm", scope: { company: "새온그룹" } });
    expect(p.sitesMoved).toBe(0);
  });
  test("a person sent elsewhere is named; a destination at another 사업장 counts as a 전근", () => {
    const p = dissolvePlan({ ...base, overrides: new Map([["p2", at("qt").node]]) });
    const moves = p.ops.filter((o) => o.op === "REASSIGN_ORG_UNIT");
    expect(moves.map((o) => o.op === "REASSIGN_ORG_UNIT" && [o.toOrgUnit, o.employeeIds])).toEqual([["pm", ["p1"]], ["qt", ["p2"]]]);
    expect(p.sitesMoved).toBe(1);
  });
  test("a grant scoped here waits for a choice; re-pointed on a later date it ends and begins on that day", () => {
    const g = { id: "g1", account_id: "a1", role_id: "r1", role_name_ko: "인사 실무", scope: { kind: "DEPARTMENT", node_id: "qa", include_descendants: true } } as never;
    expect(scopedGrants([g], "qa")).toHaveLength(1);
    expect(dissolvePlan({ ...base, grants: [g] }).grantsOpen).toBe(1);
    const later = dissolvePlan({ ...base, grants: [g], choices: new Map([["g1", "rescope"]]), date: "2026-11-02" });
    expect(later.grantOps).toEqual([
      { op: "set_end", grant_id: "g1", valid_to: "2026-11-02T00:00:00+09:00" },
      { op: "grant", account_id: "a1", role_id: "r1", scope: { kind: "DEPARTMENT", node_id: "pm", include_descendants: true }, valid_from: "2026-11-02T00:00:00+09:00", valid_to: null, effective_in_setup: false },
    ]);
    expect(dissolvePlan({ ...base, grants: [g], choices: new Map([["g1", "end"]]) }).grantOps).toEqual([{ op: "revoke", grant_id: "g1" }]);
  });
});

describe("merge", () => {
  test("into another 사업장: every member changes 사업장 and 고용보험 unit", () => {
    const m = mergePlan(at("qa"), at("qt"), ei, "새온그룹");
    expect(m.totals).toEqual({ children: 2, members: 38, siteChanged: 38, eiChanged: 38 });
    expect(m.after.n).toBe(172 + 38);
    const merged = m.after.children.find((c) => c.tag === "merged")!;
    expect([merged.name, merged.n, merged.children.map((c) => c.tag)]).toEqual(["품질팀", 53, ["movedIn", "movedIn"]]);
    expect(m.setupOps.at(-1)).toEqual({ op: "DISSOLVE", org_unit_id: "qa", expected_version: 1 });
  });
  test("after 운영 시작 a merge is one change that keeps its successor (regression: org-07)", () => {
    const m = mergePlan(at("qa"), at("qt"), ei, "새온그룹");
    expect(m.govOps.map((o) => o.op)).toEqual(["MOVE_ORG_UNIT", "MOVE_ORG_UNIT", "REASSIGN_ORG_UNIT", "DISSOLVE_ORG_UNIT"]);
    expect(m.govOps.at(-1)).toEqual({ op: "DISSOLVE_ORG_UNIT", orgUnitId: "qa", mergedInto: "qt" });
  });
});

describe("bulk move", () => {
  test("a clash must be resolved; a rename goes before the move", () => {
    const roots = [qa, at("eq").node, at("pm").node];
    const open = bulkPlan(places, roots, at("as"), new Map(), ei);
    expect([open.ready, open.unresolved, open.rows[2]?.clash?.id]).toEqual([false, 1, "am"]);
    const done = bulkPlan(places, roots, at("as"), new Map([["pm", { kind: "rename", name: "평택생산관리팀" }]]), ei);
    expect(done.totals).toEqual({ units: 5, members: 78, siteChanged: 78, eiChanged: 78 });
    expect(done.sites.map((x) => [x.node.name, x.change])).toEqual([["평택공장", -78], ["아산공장", 78]]);
    expect(done.items).toEqual({ moves: 3, renames: 1, merges: 0 });
    expect(done.setupOps().slice(-2)).toEqual([
      { op: "RENAME", org_unit_id: "pm", expected_version: 1, name: "평택생산관리팀" },
      { op: "MOVE", org_unit_id: "pm", expected_version: 2, workplace_id: "as" },
    ]);
  });
  test("a rename into another taken name is still open", () => {
    const p = bulkPlan(places, [at("pm").node], at("as"), new Map([["pm", { kind: "rename", name: "품질팀" }]]), ei);
    expect(p.ready).toBe(false);
  });
});
