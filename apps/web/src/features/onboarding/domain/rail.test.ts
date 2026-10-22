import { expect, test } from "vitest";
import type { Checklist, ChecklistStep } from "@console/api/pending";
import { finished, fixFor, grouped, recordFix } from "./rail";

test("legacy company-text mapping opens the existing placement flow", () => {
  expect(fixFor("map_company_names")).toEqual({ to: "/people/unplaced" });
});

const step = (key: ChecklistStep["key"], group: ChecklistStep["group"], state: ChecklistStep["state"] = "todo"): ChecklistStep => ({ key, group, state, action: "x", skippable: false, can_act: true, needs: "org::edit", paths: ["one", "paste", "import"], counts: { entities: 0, workplaces: 0, units: 0, people: 0, unplaced: 0, entity_unknown: 0 } });

test("the server's steps are grouped in its order, and nothing is invented", () => {
  const c: Checklist = { phase: "SETUP", go_live_at: null, summary: { people: 0, placed: 0, unplaced: 0, entity_unknown: 0, progress: 25 }, done: 1, total: 4, steps: [step("entity", "company", "attention"), step("org", "operations"), step("employees", "people", "blocked"), step("golive", "people")] };
  expect(grouped(c).map((g) => [g.key, g.steps.map((s) => s.key)])).toEqual([["company", ["entity"]], ["operations", ["org"]], ["people", ["employees", "golive"]]]);
  expect(finished(c.steps[0]!)).toBe(true);
  expect(finished(c.steps[2]!)).toBe(false);
});

test("every remedy the server sends either opens its screen or stays text, never a dead link", () => {
  expect(fixFor("create_legal_entity")).toEqual({ to: "/org/entities/new" });
  expect(fixFor("invite_executive")).toEqual({ to: "/people", search: { view: "accounts" } });
  expect(fixFor("accept_terms")).toEqual({ to: "/setup/go-live" });
  expect(fixFor("none")).toBeUndefined();
  expect(fixFor("security_contact_store_pending")).toBeUndefined();
  expect(fixFor(null)).toBeUndefined();
});

test("company-53: a counted record's fix opens on that record, a 사업장 selected on its 법인", () => {
  expect(recordFix({ kind: "workplace", id: "w4", name: "오송공장", legal_entity_id: "e1" })).toEqual({ to: "/org/entities/$id", params: { id: "e1" }, search: { wp: "w4" } });
  expect(recordFix({ kind: "registration", id: "r1", name: "주식회사 새온정밀", legal_entity_id: "e1" })).toEqual({ to: "/org/entities/$id", params: { id: "e1" }, search: {} });
  expect(recordFix({ kind: "legal_entity", id: "e2", name: "새온리테일", legal_entity_id: "e2" })?.params).toEqual({ id: "e2" });
});

test("company-49: the contact store that does not exist has no fix and no link", () => {
  expect(fixFor("security_contact_store_pending")).toBeUndefined();
  // The second passkey is added in place, never a link away.
  expect(fixFor("add_passkey")).toBeUndefined();
});

test("roles remain after employees even when the operations group occurs earlier", () => {
  const c: Checklist = { phase: "SETUP", go_live_at: null, done: 0, total: 4,
    summary: { people: 0, placed: 0, unplaced: 0, entity_unknown: 0, progress: 0 },
    steps: [step("org", "operations"), step("employees", "people"), step("roles", "operations"), step("golive", "people")] };
  expect(grouped(c).flatMap((g) => g.steps.map((s) => s.key))).toEqual(["org", "employees", "roles", "golive"]);
});

test("the old entity remedy remains accepted alongside registration and placement", () => {
  expect(fixFor("register_legal_entity")).toEqual(fixFor("upload_or_enter_certificate"));
  expect(fixFor("place_people")).toEqual({ to: "/people/unplaced" });
  expect(recordFix({ kind: "employee", id: "p1", name: "A", legal_entity_id: "" })?.to).toBe("/people/unplaced");
});

test("an unknown record kind has no guessed entity link", () => {
  expect(recordFix({ kind: "future_kind", id: "p1", name: "A", legal_entity_id: "e1" })).toBeUndefined();
});
