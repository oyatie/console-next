import { expect, test } from "vitest";
import type { components } from "@console/api/schema";
import { alike, fromQueue, groupBySource, suggest } from "./unplaced";

type Employee = components["schemas"]["Employee"];
const e = (id: string, worksite: string | null, unit: string | null = null) => ({ id, worksite_name: worksite, org_unit_id: unit, workplace_id: null, status: "ACTIVE" }) as unknown as Employee;
const u = (id: string, name: string) => ({ id, name, kind: "TEAM", status: "ACTIVE" }) as components["schemas"]["OrgUnitHead"];

test("unplaced people group by the file's value, largest first, no value last", () => {
  const people = [e("1", "아산"), e("2", ""), e("3", "본사"), e("4", "아산")];
  expect(groupBySource(people).map((g) => [g.value, g.people.length])).toEqual([["아산", 2], ["본사", 1], ["", 1]]);
});

test("a queued person groups by the 부서 text the file named, else the record's own value; the line alone stands in for a record not read", () => {
  type Q = Parameters<typeof fromQueue>[0];
  const q = (id: string, source: string | null, entity: string | null = null): Q => ({ employee_id: id, name: `n${id}`, company: "c", source_org_unit: source, legal_entity_id: entity, reason: source ? "unit_unknown" : "no_place" });
  const placedAtSite = fromQueue(q("1", "품질팀", "le1"), e("1", "평택공장"));
  expect(placedAtSite.legal_entity_id).toBe("le1");
  // Someone with no workplace groups by the workplace value even when the file also named a department.
  const noPlace = fromQueue({ ...q("4", "미정"), reason: "no_place" }, e("4", "아산"));
  const people = [placedAtSite, fromQueue(q("2", null), e("2", "아산")), fromQueue(q("3", "품질팀")), noPlace];
  expect(groupBySource(people).map((g) => [g.value, g.people.map((p) => p.id)])).toEqual([["품질팀", ["1", "3"]], ["아산", ["2", "4"]]]);
  expect(people[2]!.name).toBe("n3");
});

test("suggestions: alike names first, then recent places, at most five", () => {
  expect(alike("아산", "아산공장")).toBe(true);
  expect(alike("생산", "생산1팀")).toBe(true);
  expect(alike("본사", "생산1팀")).toBe(false);
  const places = [
    { unit: u("a", "조립1팀"), text: "새온정밀 › 아산공장 › 생산부 › 조립1팀" },
    { unit: u("b", "생산1팀"), text: "새온정밀 › 평택공장 › 생산부 › 생산1팀" },
    { unit: u("c", "인사팀"), text: "새온정밀 › 평택공장 › 경영지원부 › 인사팀" },
  ];
  // The company name is not compared (every place shares it); the workplace and department are.
  expect(suggest("아산", places, ["c", "a"]).map((s) => [s.unit.id, s.why])).toEqual([["a", "alike"], ["c", "recent"]]);
});

test("an unknown statutory workplace groups by its source value without becoming a physical site", () => {
  const person = fromQueue({ employee_id: "person", name: "직원", company: "", reason: "no_place", source_workplace: "평택 1공장" });
  expect(groupBySource([person])[0]?.value).toBe("평택 1공장");
  expect(person.worksite_name).toBeUndefined();
});
