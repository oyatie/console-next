import { expect, test } from "vitest";
import { approveWord, autoView, diffLines, effective, fromLines, isEmpty, isRoutedApproval, liveColumns, liveLevels, sellable, toggle, toLines } from "./grid";

test("any level beyond 조회 includes 조회 automatically", () => {
  expect(effective(["edit"])).toEqual(["view", "edit"]);
  expect(effective(["export", "approve"])).toEqual(["view", "approve", "export"]);
  expect(effective(["view"])).toEqual(["view"]);
  expect(effective([])).toEqual([]);
  expect(autoView(["edit"])).toBe(true);
  expect(autoView(["view", "edit"])).toBe(false);
  expect(autoView([])).toBe(false);
});

test("toggling flips one cell; pressing an automatic 조회 clears the row", () => {
  let g = toggle({}, "hr_basic", "edit");
  expect(g).toEqual({ hr_basic: ["edit"] });
  g = toggle(g, "hr_basic", "export");
  expect(g).toEqual({ hr_basic: ["edit", "export"] });
  expect(toggle(g, "hr_basic", "view")).toEqual({});
  expect(toggle(toggle({}, "org", "view"), "org", "view")).toEqual({});
  expect(toggle(g, "hr_basic", "edit")).toEqual({ hr_basic: ["export"] });
});

test("lines go out in catalog order with effective levels and read back to the same grid", () => {
  const g = { org: ["view"], hr_basic: ["edit"] } as const;
  const lines = toLines(g, ["hr_basic", "org", "exit"]);
  expect(lines).toEqual([{ domain: "hr_basic", levels: ["view", "edit"] }, { domain: "org", levels: ["view"] }]);
  expect(fromLines(lines)).toEqual(g);
  expect(isEmpty({})).toBe(true);
  expect(isEmpty(g)).toBe(false);
});

// regression (governance-17): the grid sold 결재 on 14 domains and permissions for domains with no screen.
test("only levels with an operation are offered, and screenless domains are not sold", () => {
  const d = (domain: string, levels: ("view" | "edit" | "approve" | "export")[], ops: ("view" | "edit" | "approve" | "export")[]) =>
    ({ domain, grantable: true, levels, operations: ops.map((level) => ({ level })) });
  const hr = d("hr_basic", ["view", "edit", "approve", "export"], ["view", "edit", "edit"]);
  const attendance = d("attendance", ["view", "edit", "approve"], ["edit"]);
  const pay = d("pay", ["view", "edit", "approve"], ["view", "edit"]);
  const bank = d("bank", ["view", "edit"], []);
  const org = d("org", ["view", "edit", "approve", "export"], ["view", "edit", "approve"]);
  expect(liveLevels(hr)).toEqual(["view", "edit"]);
  expect(liveLevels(attendance)).toEqual(["view", "edit"]);
  expect([hr, pay, bank, org].filter((x) => sellable(x)).map((x) => x.domain)).toEqual(["hr_basic", "org"]);
  expect(liveColumns([hr, pay, bank])).toEqual(["view", "edit"]);
  expect(liveColumns([hr, org])).toEqual(["view", "edit", "approve"]);
});

const op = (domain: string, levels: ("view" | "edit" | "approve" | "export")[]) => ({ domain, grantable: true, levels: ["view", "edit", "approve", "export"] as ("view" | "edit" | "approve" | "export")[], operations: levels.map((level) => ({ level })) });

// regression (governance-03, #26): with nothing routed the grid sold 결재 on 조직 and 퇴직.
test("조직's approve is offered once org changes route; 퇴직 확인 and 예외·정정 결정 always, worded as such", () => {
  const org = op("org", ["view", "edit", "approve"]);
  const exit = op("exit", ["edit", "approve"]);
  const exceptions = op("exceptions", ["edit", "approve"]);
  const none = new Set<string>();
  expect(liveLevels(org, none)).toEqual(["view", "edit"]);
  // The HQ 확인 is still a capability the server asks for: never hidden (a tenant could not finish an exit otherwise).
  expect(liveLevels(exit, none)).toEqual(["view", "edit", "approve"]);
  expect(liveLevels(exceptions, none)).toEqual(["view", "edit", "approve"]);
  expect(liveLevels(org, new Set(["org_structure"]))).toEqual(["view", "edit", "approve"]);
  expect([approveWord("exit", none), approveWord("exceptions", none), approveWord("exit", new Set(["exit"]))]).toEqual(["confirm", "decide", "routed"]);
  expect(isRoutedApproval("exceptions", new Set(["org_structure"]))).toBe(false);
});

// regression (governance-04): permissions need both a screen and a tagged operation.
test("export is a column once an operation carries it; screenless domains move to not yet", () => {
  const hr = op("hr_basic", ["view", "edit", "export"]);
  expect(liveColumns([hr], new Set())).toEqual(["view", "edit", "export"]);
  expect(["pay", "evaluation", "notice"].map((d) => sellable(op(d, ["view", "edit"]), new Set()))).toEqual([false, false, false]);
  for (const domain of ["audit", "settings", "retention"]) {
    expect(sellable(op(domain, ["view"]), new Set())).toBe(true);
    expect(liveLevels(op(domain, ["view"]), new Set())).toEqual(["view"]);
    expect(sellable(op(domain, []), new Set())).toBe(false);
  }
});

test("ROL-M2: a held role's edit names what each domain gains and loses", () => {
  expect(diffLines({ hr_basic: ["edit"], org: ["view"] }, { hr_basic: ["edit", "export"] }, ["org", "hr_basic"])).toEqual([
    { domain: "org", added: [], removed: ["view"] },
    { domain: "hr_basic", added: ["export"], removed: [] },
  ]);
});
