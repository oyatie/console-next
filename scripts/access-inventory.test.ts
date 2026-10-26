// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "vitest";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import * as access from "./access-inventory.mjs";
const { inventory, ratchet, checkRatchet, rustInventory, webInventory } = access;

test("matrix census counts method calls, including multiline platform capabilities", () => {
  const found = rustInventory("reader.rs", `fn read() {
    principal.authorize_scoped(action, node);
    p.authorize(PlatformFeature::TenantList);
    p\n      .authorize(console_platform_authz::PlatformFeature::TenantManage);
    authorize(&principal, action);
    Action::new(feature);
  }`);
  expect(found.references.filter((r: { model: string }) => r.model === "matrix")).toHaveLength(5);
});

test("function declarations and Cedar point methods are not matrix calls", () => {
  const source = readFileSync("backend/crates/platform/authz/src/cedar_pbac/visible.rs", "utf8");
  expect(rustInventory("visible.rs", source).references.filter((r: { model: string }) => r.model === "matrix")).toEqual([]);
  expect(rustInventory("reader.rs", "fn authorize_scoped() {} fn read() { facts.authorize(action, node); }").references).toEqual([]);
});

test("inline test modules are masked without hiding later production code or shifting lines", () => {
  const source = `fn first() { authorize(); }
#[cfg(test)]
mod tests { fn test_only() { authorize(); let x = r#"}"#; } }
fn after() { p.authorize_scoped(action, node); }
#[cfg(test)]
#[path = "tests.rs"] mod external;
fn last() { authorize(); }`;
  const found = rustInventory("reader.rs", source);
  expect(found.functions.map((f: { name: string }) => f.name)).toEqual(["first", "after", "last"]);
  expect(found.references.map((r: { line: number }) => r.line)).toEqual([1, 4, 7]);
});

test("a cfg(test) decoy in a comment or literal cannot hide serving code", () => {
  const found = rustInventory("reader.rs", `// #[cfg(test)] mod tests
const DECOY: &str = "#[cfg(test)] mod tests";
fn read() { authorize(); }`);
  expect(found.functions.map((f: { name: string }) => f.name)).toEqual(["read"]);
  expect(found.references.map((r: { line: number }) => r.line)).toEqual([3]);
});

test("ordinary gate runs persist decreases and never restore retired access budget", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "access-ratchet-"));
  const output = path.join(dir, "inventory");
  const data = { ...rustInventory("reader.rs", "fn read() { authorize(); authorize(); }"), web: [] };
  const initial = ratchet(data);
  writeFileSync(`${output}.json`, JSON.stringify(initial));
  writeFileSync(`${output}.md`, "old budget");
  const smaller = ratchet({ ...data, references: data.references.slice(1) });
  try {
    access.writeRatchet(smaller, output);
    expect(JSON.parse(readFileSync(`${output}.json`, "utf8"))).toEqual(smaller);
    expect(readFileSync(`${output}.md`, "utf8")).toContain("| matrix | reader.rs | reference | 1 |");
    expect(() => access.writeRatchet(initial, output)).toThrow("Access ratchet increased");
    expect(() => access.writeRatchet(initial, output, true)).toThrow("Access ratchet increased");
    expect(JSON.parse(readFileSync(`${output}.json`, "utf8"))).toEqual(smaller);
    access.writeRatchet(ratchet({ ...data, references: [] }), output);
    expect(JSON.parse(readFileSync(`${output}.json`, "utf8")).limits).toEqual([]);
    expect(() => access.writeRatchet(smaller, output)).toThrow("Access ratchet increased");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the CLI lowers its budget without --write and refuses reintroductions even with --write", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "access-census-"));
  const source = "backend/app/src/main.rs";
  const budget = "docs/authz/access-inventory.json";
  const initial = "fn main() { authorize(); authorize(); }";
  const current = "fn main() { authorize(); }";
  const counts = (text: string) => ratchet({ ...rustInventory(source, text), web: [] });
  try {
    for (const folder of ["scripts/lib", "backend/app/src", "backend/crates", "backend/openapi", "apps/web/src", "docs/authz"]) {
      mkdirSync(path.join(dir, folder), { recursive: true });
    }
    for (const file of ["access-inventory.mjs", "check-request-body-contract.mjs", "own-property.mjs", "lib/rust-request-fields.mjs"]) {
      cpSync(path.join("scripts", file), path.join(dir, "scripts", file));
    }
    symlinkSync(path.resolve("node_modules"), path.join(dir, "node_modules"), "dir");
    writeFileSync(path.join(dir, "backend/openapi/openapi.yaml"), "paths: {}\n");
    writeFileSync(path.join(dir, source), current);
    writeFileSync(path.join(dir, budget), JSON.stringify(counts(initial)));
    const run = (...args: string[]) => spawnSync("node", ["scripts/access-inventory.mjs", ...args], { cwd: dir, encoding: "utf8" });
    const lowered = run();
    expect(lowered.status, lowered.stdout + lowered.stderr).toBe(0);
    expect(JSON.parse(readFileSync(path.join(dir, budget), "utf8"))).toEqual(counts(current));
    writeFileSync(path.join(dir, source), initial);
    for (const args of [[], ["--write"]]) {
      const refused = run(...args);
      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain("Access ratchet increased");
      expect(JSON.parse(readFileSync(path.join(dir, budget), "utf8"))).toEqual(counts(current));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

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
