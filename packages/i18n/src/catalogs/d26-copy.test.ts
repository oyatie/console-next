import { expect, test } from "vitest";
import { en } from "./en";
import { ko } from "./ko";

// Decisions #26: 결재 is off by default (approval.policy.<class> = none). The copy a tenant on the default sees
// (the setup rail, the go-live preview, Home, change history) never asks for or promises a 결재; the `.routed`
// variants and the route-only go-live items (sole holder, second approver) keep it. regression (W10).
const NONE_PATH = [
  "setup.org.placementDept",
  "setup.org.placementDirect",
  "setup.contact.title",
  "setup.golive.becomes.entity_identifier_corrections_locked",
  "setup.golive.becomes.org_structure_changes_through_proposals",
  "home.empty.title",
  "home.empty.reason",
  "home.tiles.org",
  "home.mine.title",
  "home.waiting.empty",
  "enum.changeMode.GOVERNED",
  "enum.changeMode.SOLE_HOLDER",
  "tenants.next.setup",
] as const;

const ROUTED = ["setup.golive.becomes.org_structure_changes_need_approval"] as const;

test.each(NONE_PATH)("regression W10: ko %s says nothing of 결재, 기안 or 상신", (id) => {
  expect(ko[id]).toBeDefined();
  expect(ko[id]).not.toMatch(/결재|기안|상신/);
});

test.each(NONE_PATH)("regression W10: en %s says nothing of approval or drafting", (id) => {
  expect(en[id] ?? ko[id]).not.toMatch(/approv|draft/i);
});

test.each(ROUTED)("%s keeps 결재 for a tenant that routes the change", (id) => {
  expect(ko[id]).toMatch(/결재/);
  expect(en[id]).toMatch(/approval/);
});

test("no title implies access: the remedy for a missing approver names no 임원", () => {
  expect(ko["setup.fix.invite_executive"]).not.toMatch(/임원/);
  expect(ko["setup.remedy.invite_executive"]).not.toMatch(/임원/);
  expect(ko["setup.golive.item.org_change_needs_second_person_after_go_live"]).not.toMatch(/임원/);
});

test("the contact form carries no standing explanation", () => {
  expect(ko).not.toHaveProperty("setup.contact.why");
  expect(en).not.toHaveProperty("setup.contact.why");
});
