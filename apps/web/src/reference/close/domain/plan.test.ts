import { describe, expect, it } from "vitest";
import type { StructureNode } from "@console/api/pending";
import type { ClosePlanView } from "./plan";
import { allTo, canGoWith, EMPTY, groups, missing, planAll, planned, planUnit, preview, request, topOf, type GroupPlan } from "./plan";
import { EMPTY_FACTS } from "../../group-transfer/domain/facts";

// 판교지점 (own unit S) with 개발팀 D › 품질팀 Q and 물류팀 L; 김 in D, 이 in Q, 박 directly at S, 최 in L.
const view: ClosePlanView = {
  workplace_id: "W",
  legal_entity_id: "E",
  site_org_unit_id: "S",
  closed_on: null,
  holds_entity_role: false,
  units: [
    { org_unit_id: "D", name: "개발팀", parent_org_unit_id: "S", version: 1 },
    { org_unit_id: "Q", name: "품질팀", parent_org_unit_id: "D", version: 1 },
    { org_unit_id: "L", name: "물류팀", parent_org_unit_id: "S", version: 1 },
  ],
  people: [
    { employee_id: "kim", name: "김", employee_number: null, org_unit_id: "D", hire_date: null },
    { employee_id: "lee", name: "이", employee_number: null, org_unit_id: "Q", hire_date: null },
    { employee_id: "park", name: "박", employee_number: null, org_unit_id: "S", hire_date: null },
    { employee_id: "choi", name: "최", employee_number: null, org_unit_id: "L", hire_date: null },
  ],
  exit_cases: [],
  job: null,
};
const node = (kind: StructureNode["kind"], id: string, name: string, children: StructureNode[] = [], org_unit_id?: string): StructureNode =>
  ({ kind, id, name, org_unit_id, headcount: 0, direct_headcount: 0, dispatched_headcount: 0, chips: [], children }) as StructureNode;
const entity = node("LEGAL_ENTITY", "E", "가나", [node("WORKPLACE", "H", "본사", [node("DEPARTMENT", "HR", "인사팀")], "HS"), node("WORKPLACE", "W", "판교지점", [], "S")]);

describe("close plan", () => {
  it("groups people by the 부서 directly under the 사업장, with no-부서 people last", () => {
    expect(topOf(view, "Q")).toBe("D");
    expect(topOf(view, "S")).toBeUndefined();
    expect(groups(view).map((g) => [g.unit?.name ?? "", g.people.map((p) => p.employee_id)])).toEqual([
      ["개발팀", ["kim", "lee"]],
      ["물류팀", ["choi"]],
      ["", ["park"]],
    ]);
  });

  it("keeps the server's (the chart's) 부서 order, not name order", () => {
    const stored = { ...view, units: [view.units[2]!, view.units[0]!, view.units[1]!] };
    expect(groups(stored).map((g) => g.unit?.name ?? "")).toEqual(["물류팀", "개발팀", ""]);
  });

  it("names the one thing left, in order, until the plan is complete", () => {
    expect(missing(view, EMPTY, "")[0]).toEqual({ what: "date" });
    expect(missing(view, EMPTY, "2026-10-07")[0]).toEqual({ what: "unit", name: "개발팀", count: 2 });
    expect(missing({ ...view, holds_entity_role: true }, EMPTY, "2026-10-07")[0]).toEqual({ what: "role" });
    let d = planUnit(view, EMPTY, "D", { kind: "move", to: "HS" });
    d = planUnit(view, d, "L", { kind: "dissolve" });
    expect(missing(view, d, "2026-10-07")).toEqual([{ what: "people", count: 2, first: "박" }]);
    d = planAll(d, view.people.filter((p) => ["park", "choi"].includes(p.employee_id)), { kind: "exit", reason: "CLOSURE" });
    expect(missing(view, d, "2026-10-07")).toEqual([]);
  });

  it("a moved 부서 takes its people along; dissolving it again leaves them unplanned (regression: no stale 「함께」)", () => {
    let d = planUnit(view, EMPTY, "D", { kind: "move", to: "HS" });
    expect(d.people.kim).toEqual({ kind: "with" });
    expect(canGoWith(view, d, view.people[1]!)).toBe(true);
    d = planUnit(view, d, "D", { kind: "dissolve" });
    expect(missing(view, d, "2026-10-07").find((m) => m.what === "people")).toEqual({ what: "people", count: 4, first: "김" });
  });

  it("「모두 본사로」 is a complete plan in one press, and its request has a line for everyone and every 부서", () => {
    const d = allTo(view, "HS");
    expect(missing(view, d, "2026-10-07")).toEqual([]);
    expect(request(view, d, "2026-10-07")).toEqual({
      closed_on: "2026-10-07",
      units: [
        { org_unit_id: "D", action: "MOVE", to_parent_id: "HS" },
        { org_unit_id: "L", action: "MOVE", to_parent_id: "HS" },
      ],
      people: [
        { employee_id: "kim", action: "TRANSFER", to_org_unit_id: "D" },
        { employee_id: "lee", action: "TRANSFER", to_org_unit_id: "Q" },
        { employee_id: "park", action: "TRANSFER", to_org_unit_id: "HS" },
        { employee_id: "choi", action: "TRANSFER", to_org_unit_id: "L" },
      ],
    });
  });

  it("previews exact counts per destination 사업장 and per 퇴직 사유", () => {
    let d = planUnit(view, EMPTY, "D", { kind: "move", to: "HR" });
    d = planUnit(view, d, "L", { kind: "dissolve" });
    d = planAll(d, [view.people[2]!], { kind: "exit", reason: "INSOLVENCY" });
    d = planAll(d, [view.people[3]!], { kind: "to", to: "HS" });
    expect(preview(view, d, entity)).toEqual({ to: [["본사", 3]], exits: { CLOSURE: 0, INSOLVENCY: 1 }, groups: 0, moved: 1, dissolved: 1 });
  });
});

describe("close plan, incomplete choices", () => {
  it("a 전근 or a moved 부서 without a destination is still missing", () => {
    let d = planUnit(view, EMPTY, "D", { kind: "move", to: "" });
    d = planUnit(view, d, "L", { kind: "dissolve" });
    expect(missing(view, d, "2026-10-07")[0]).toEqual({ what: "unit", name: "개발팀", count: 1 });
    d = planUnit(view, d, "D", { kind: "move", to: "HS" });
    d = planAll(d, view.people.slice(2), { kind: "to", to: "" });
    expect(missing(view, d, "2026-10-07")).toEqual([{ what: "people", count: 2, first: "박" }]);
  });
});

describe("close plan, a group transfer to another legal entity", () => {
  const facts = { ...EMPTY_FACTS, severance: "SETTLED", annualLeave: "SETTLED", seniority: "RESTART", consentDate: "2026-10-01", consentRef: "전적 동의서", groupStart: "2020-03-02" } as const;
  const whole: GroupPlan = { kind: "group", entity: "B", to: "BU", workplaceId: "BW", facts };
  const rest = (d: ReturnType<typeof planUnit>) => planAll(planUnit(view, planUnit(view, d, "D", { kind: "dissolve" }), "L", { kind: "dissolve" }), view.people.slice(1), { kind: "exit", reason: "CLOSURE" });

  it("counts only once its destination and every fact are there, with the dates on or before the closing date", () => {
    const bare = planAll(EMPTY, [view.people[0]!], { ...whole, facts: { ...facts, severance: null } });
    expect(planned(view, bare, view.people[0]!)).toBe(false);
    expect(planned(view, planAll(EMPTY, [view.people[0]!], { ...whole, to: "" }), view.people[0]!)).toBe(false);
    const d = rest(planAll(EMPTY, [view.people[0]!], whole));
    expect(planned(view, d, view.people[0]!)).toBe(true);
    expect(missing(view, d, "2026-09-30")).toEqual([{ what: "people", count: 1, first: "김" }]);
    expect(missing(view, d, "2026-10-31")).toEqual([]);
  });

  it("is sent as a GROUP_TRANSFER line with the receiving 사업장 and the facts, and counted in the preview", () => {
    const d = rest(planAll(EMPTY, [view.people[0]!], whole));
    expect(request(view, d, "2026-10-31").people![0]).toEqual({
      employee_id: "kim", action: "GROUP_TRANSFER", to_org_unit_id: "BU", to_workplace_id: "BW",
      group_transfer: {
        continuity: "SETTLED", annual_leave_continuity: "SETTLED", seniority_continuity: "RESTART",
        group_service_start_date: "2020-03-02", consent_date: "2026-10-01", consent_evidence_ref: "전적 동의서", succession_evidence_ref: undefined,
      },
    });
    expect(preview(view, d, entity).groups).toBe(1);
  });
});
