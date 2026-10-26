// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { inventory, ratchet, checkRatchet, rustInventory, webInventory } from "./access-inventory.mjs";

test("inventory detects scoped attendance refusal, lost department selector and constant Cedar facts", () => {
  const source = `
fn branch_request_is_well_scoped(scope: &BranchScope, branch_id: Option<Uuid>) -> bool {
  branch_id.is_some() || matches!(scope, BranchScope::All)
}
async fn day_board() {
  let rows = people.filter(|p| { visible(p) && q.workplace_id.is_none_or(|w| p.workplace_id == Some(w)) });
  let open = q.unit_id == p.unit;
}
fn reveal() { employee_pii::decide(EmployeePiiFacts { holder: true, step_up: true }); }
fn models() { authorize(); let grant: ScopeGrant; with_org_conn(); }
// fn fake() { BranchScope::All }
const DECOY: &str = "ScopeGrant authorize()";
`;
  const result = rustInventory("board.rs", source);
  expect(result.findings.map((f: { kind: string }) => f.kind)).toEqual([
    "branch-required-for-scoped-holder", "department-selector-missing-from-row-filter", "all-boolean-facts-hardcoded-true",
  ]);
  expect(result.references.filter((r: { model: string }) => r.model === "ScopeGrant")).toHaveLength(1);
  expect(new Set(result.references.map((r: { model: string }) => r.model))).toEqual(new Set(["matrix", "BranchScope", "ScopeGrant", "Cedar", "RLS"]));
});

test("web AST inventories route/nav guards and aliased grant hooks, ignoring comments", () => {
  const source = `import { useCan as permission } from "./authz";
const route = createRoute({ path: "/people", beforeLoad: gate({ anyOf: [["people_read"]] }) });
const nav = [{ to: "/people", anyOf: [["people_read"]] }];
const can = permission(); // anyOf: fake
const shown = can("people_read");
`;
  const found = webInventory("apps/web/src/routes/test.ts", source);
  expect(found.filter((r: { model: string }) => r.model === "web-grants")).toHaveLength(4);
  expect(found.some((r: { name: string }) => r.name === 'can("people_read")')).toBe(true);
  expect(found.find((r: { kind: string }) => r.kind === "route")?.model).toBe("route-hook-unmapped");
  expect(webInventory("apps/web/src/shell/nav.ts", source).some((r: { kind: string }) => r.kind === "nav")).toBe(true);
});

test("ratchet ignores line shifts, accepts removals and refuses a new finding or increased count", () => {
  const found = rustInventory("board.rs", "fn reveal() { pii::decide(PiiFacts { holder: true }); }");
  const data = { references: found.references, findings: found.findings, web: [] };
  const baseline = ratchet(data);
  expect(ratchet({ ...data, findings: found.findings.map((f: object) => ({ ...f, line: 900 })) })).toEqual(baseline);
  expect(() => checkRatchet(ratchet({ ...data, findings: [] }), baseline)).not.toThrow();
  expect(() => checkRatchet(ratchet({ ...data, findings: [...found.findings, ...found.findings] }), baseline)).toThrow("Access ratchet increased");
  const novel = rustInventory("new.rs", "fn reveal() { pii::decide(PiiFacts { holder: true }); }");
  expect(() => checkRatchet(ratchet({ ...data, findings: [...found.findings, ...novel.findings] }), baseline)).toThrow("new.rs");
  const legacy = rustInventory("new.rs", "fn read() { authorize(); }");
  expect(() => checkRatchet(ratchet({ ...data, references: legacy.references }), baseline)).toThrow("matrix");
});

test("committed ratchet permits the source census; routes remain discoverable", () => {
  const result = spawnSync("node", ["scripts/access-inventory.mjs"], { encoding: "utf8" });
  expect(result.status, result.stdout + result.stderr).toBe(0);
  const baseline = JSON.parse(readFileSync("docs/authz/access-inventory.json", "utf8"));
  expect(JSON.stringify(baseline)).not.toMatch(/"line"/);
  const data = inventory(process.cwd());
  for (const file of ["people", "org", "attendance", "entity", "onboarding", "org-bulk"]) {
    expect(data.web.some((r: { file: string }) => r.file === `apps/web/src/routes/${file}.ts`)).toBe(true);
  }
}, 120_000);
