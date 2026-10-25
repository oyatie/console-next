import { describe, expect, it } from "vitest";
import type { OrgStructureNodeServed as Node } from "@console/api/pending";
import { nameKey, parseOutline } from "./outline";
import { planCounts, planOutline } from "./plan";
import { emptyAnswers, entityOps, openQuestions, orgOps, ready, type SiteAnswers } from "./ops";

const node = (kind: Node["kind"], id: string, name: string, children: Node[] = []): Node => ({ kind, id, name, headcount: 0, direct_headcount: 0, dispatched_headcount: 0, chips: [], children, version: 1 });
const entity = node("LEGAL_ENTITY", "E", "(주)새온바이오", [node("WORKPLACE", "W1", "오송 본사", [node("DEPARTMENT", "D1", "경영지원팀")])]);

describe("parseOutline", () => {
  it("reads tab indents and a kind cell on the first level", () => {
    const { rows, shape } = parseOutline("오송 본사\n\t경영지원팀\n\t연구개발본부\n\t\t원료연구팀\n오송공장\t공장\n\t생산부\n");
    expect(rows.map((r) => [r.depth, r.name, r.kind])).toEqual([
      [0, "오송 본사", undefined], [1, "경영지원팀", undefined], [1, "연구개발본부", undefined], [2, "원료연구팀", undefined], [0, "오송공장", "공장"], [1, "생산부", undefined],
    ]);
    expect(shape).toEqual({ by: "indent", depth: 3, kindColumn: true });
  });
  it("reads space indents by their smallest step and drops blank lines", () => {
    const { rows } = parseOutline("  본사\n\n      인사팀\n          급여파트");
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 2]);
    expect(rows.map((r) => r.line)).toEqual([1, 3, 4]);
  });
  it("reads paths and keeps one row per shared prefix", () => {
    const { rows, shape } = parseOutline("오송공장 > 생산부 > 원료생산1팀\n오송공장 › 생산부 › 원료생산2팀\n오송공장 > 품질팀");
    expect(rows.map((r) => `${r.depth}:${r.name}`)).toEqual(["0:오송공장", "1:생산부", "2:원료생산1팀", "2:원료생산2팀", "1:품질팀"]);
    expect(shape.by).toBe("path");
  });
  it("compares names in NFC only, never by similarity", () => {
    expect(nameKey(" 서울본사 ".normalize("NFD"))).toBe("서울본사");
    expect(nameKey("서울 본사")).not.toBe(nameKey("서울본사"));
  });
});

describe("planOutline", () => {
  const rows = parseOutline("오송 본사\n\t경영지원팀\n\t재무팀\n오송공장\t공장\n\t품질팀\n\t품질팀\n\t\t\t너무깊음").rows;
  const plan = planOutline({ kind: "entity", node: entity }, rows);
  it("links exact names, creates the rest and flags a clash and a skipped level", () => {
    expect(plan.map((r) => `${r.level}:${r.name}:${r.status}`)).toEqual([
      "workplace:오송 본사:link", "dept:경영지원팀:link", "dept:재무팀:create", "workplace:오송공장:create", "dept:품질팀:create", "dept:품질팀:clash", "dept:너무깊음:tooDeep",
    ]);
    expect(planCounts(plan)).toEqual({ workplaces: 1, depts: 2, links: 2, fix: 2 });
  });
  it("redraws with a rename that settles the clash", () => {
    const fixed = planOutline({ kind: "entity", node: entity }, rows.slice(0, 6), { 5: "품질관리팀" });
    expect(fixed[5]).toMatchObject({ name: "품질관리팀", status: "create" });
  });
  it("puts every level under a 사업장 root as 부서", () => {
    const p = planOutline({ kind: "workplace", node: entity.children[0]! }, parseOutline("경영지원팀\n\t총무파트\n신규팀").rows);
    expect(p.map((r) => `${r.level}:${r.status}`)).toEqual(["dept:link", "dept:create", "dept:create"]);
  });
  it.each([
    ["entity", "오송 본사\n\t품질팀\t잘못된칸", 2],
    ["entity", "오송 본사\n\t경영지원팀\t잘못된칸", 2],
    ["workplace", "품질팀\t잘못된칸", 1],
    ["workplace", "품질팀\n\t검사파트\t잘못된칸", 2],
  ] as const)("refuses a department's second cell under a %s root on its own line", (kind, text, line) => {
    const root = kind === "entity" ? { kind, node: entity } : { kind, node: entity.children[0]! };
    const p = planOutline(root, parseOutline(text).rows);
    expect(p.find((r) => r.line === line)).toMatchObject({ level: "dept", kind: "잘못된칸", status: "kind_not_allowed" });
    expect(planCounts(p).fix).toBe(1);
    expect(ready(p, {})).toBe(false);
    expect(orgOps(root, p, {})).not.toContainEqual(expect.objectContaining({ name: p.find((r) => r.line === line)!.name }));
    const fixed = planOutline(root, parseOutline(text.replace("\t잘못된칸", "")).rows);
    expect(planCounts(fixed).fix).toBe(0);
  });
});

describe("ops", () => {
  const plan = planOutline({ kind: "entity", node: entity }, parseOutline("오송 본사\n\t재무팀\n\t\t결산파트\n오송공장\n\t생산부").rows);
  const addr = { road: "충청북도 청주시 흥덕구 오송읍 오송생명로 1", zip: "28160", detail: "", verified: false };
  const a: SiteAnswers = { withholding: "HEAD", insurance: "MAIN", mainWorkplaceId: "W1", address: addr, openedOn: "2026-10-01" };
  it("asks every new 사업장 its questions before the commit", () => {
    expect(openQuestions(emptyAnswers())).toBe(4);
    expect(ready(plan, { wp3: { ...a, address: null } })).toBe(false);
    expect(ready(plan, { wp3: { ...a, insurance: "MAIN", mainWorkplaceId: null } })).toBe(false);
    expect(ready(plan, { wp3: a })).toBe(true);
  });
  it("writes the 사업장 first and places 부서 by the refs it returns", () => {
    const ent = entityOps({ kind: "entity", node: entity }, plan, { wp3: a }, true);
    expect(ent).toHaveLength(1);
    expect(ent[0]).toMatchObject({ op: "CREATE_WORKPLACE", ref: "wp3", legal_entity_id: "E", workplace: { name: "오송공장", withholding_mode: null } });
    expect((ent[0]!.workplace!.insurance!.insurers ?? []).every((i) => i.unit_mode === "PART_OF" && i.main_workplace_id === "W1")).toBe(true);
    expect(orgOps({ kind: "entity", node: entity }, plan, { wp3: "W9" })).toEqual([
      { op: "CREATE", ref: "u1", name: "재무팀", workplace_id: "W1" },
      { op: "CREATE", ref: "u2", name: "결산파트", parent_ref: "u1" },
      { op: "CREATE", ref: "u4", name: "생산부", workplace_id: "W9" },
    ]);
  });
});

it("a kind cell on a path belongs to its leaf and is refused on a department line", () => {
  const root = { kind: "entity" as const, node: entity };
  const p = planOutline(root, parseOutline("오송 본사 > 품질팀\t잘못된칸").rows);
  expect(p.find(r => r.name === "품질팀")).toMatchObject({ line: 1, kind: "잘못된칸", status: "kind_not_allowed" });
  expect(p.find(r => r.name === "오송 본사")?.kind).toBeUndefined();
  expect(ready(p, {})).toBe(false);
});
it("a repeated path cannot discard an invalid extra cell", () => {
  const root = { kind: "entity" as const, node: entity };
  const p = planOutline(root, parseOutline("오송 본사 > 품질팀\n오송 본사 > 품질팀\t잘못된칸").rows);
  expect(p.find(r => r.line === 2)).toMatchObject({ kind: "잘못된칸", status: "kind_not_allowed" });
  expect(ready(p, {})).toBe(false);
});
