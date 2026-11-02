// SPDX-License-Identifier: LicenseRef-Proprietary
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createRouter, type AnyRoute } from "@tanstack/react-router";
import { expect, test } from "vitest";
import { routeTree } from "./tree";
import { routeReads, readRequirement } from "./route-reads";
import { accessRefusal, type Requirement } from "../reference/authz/domain/access";
import type { AccessEffective } from "../reference/authz/api";
import { pendingPayrollReads } from "./pending-payroll-reads";
import { operationAccess } from "../reference/authz/domain/operation-access";

const router = createRouter({ routeTree });
const routes: Record<string, AnyRoute> = router.routesByPath;
const yaml = createRequire(import.meta.url)("js-yaml");
const spec = yaml.load(readFileSync("backend/openapi/openapi.yaml", "utf8"));
const scopeKinds: AccessEffective["entries"][number]["scope"]["kind"][] = spec.components.schemas.AccessScopeKind.enum;
const source = (file: string) => readFileSync(`backend/crates/${file}`, "utf8");

test("the table covers every guarded leaf; hubs compose only those leaf requirements", () => {
  const guarded = Object.values(routes).filter(route => {
    const need = route.options.staticData?.access;
    if (!need || need === "signed-in") return false;
    if (!("destinations" in need)) return true;
    expect(need.destinations.length, route.fullPath).toBeGreaterThan(0);
    for (const destination of need.destinations) expect(Object.keys(routeReads).some(path => routes[path]?.options.staticData?.access === destination), route.fullPath).toBe(true);
    return false;
  }).map(route => route.fullPath);
  expect(Object.keys(routeReads).sort()).toEqual(guarded.sort());
});

test("access person declares its account read without changing the effective-read scope", () => {
  const read = "GET /api/v1/access/people/{id}";
  expect(routeReads["/access/people/$accountId"].reads).toContain(read);
  const effective = operationAccess["GET /api/v1/access/accounts/{accountId}/effective"];
  expect(operationAccess).toHaveProperty(read, effective);
  expect(readRequirement("/access/people/$accountId")).toEqual(effective);
});

for (const [path, contract] of Object.entries(routeReads)) {
  const ops = [...contract.reads, ...("command" in contract ? [contract.command] : [])];
  test(`${path}: exact generated contract, including scopes and all prerequisites`, () => {
    expect(contract.reads.length).toBeGreaterThan(0);
    expect(contract.reads.every(op => op.startsWith("GET "))).toBe(true);
    expect(routes[path]!.options.staticData?.access).toEqual(readRequirement(path as keyof typeof routeReads));
  });
  for (const kind of [...scopeKinds, null]) {
    test(`${path} × ${kind ?? "no grant"}: route admits iff required first reads and form door admit`, () => {
      const requirements: Requirement[] = ops.map(op => ({ ...operationAccess, ...pendingPayrollReads })[op]);
      const held = { is_ops: false,
        decisions: Object.fromEntries(requirements.flatMap(need => "action" in need ? [[need.action, kind === "TENANT"]] : [])),
        entries: kind ? requirements.flatMap((need, i) => "action" in need ? [] : [{ ...need, grant_id: String(i), enforcement: "ENFORCED", scope: { kind } }]) : [],
      } as unknown as AccessEffective;
      // Independent evaluator: never call the UI decision to calculate the expected server verdict.
      const readAdmits = (need: Requirement) => "action" in need ? held.decisions?.[need.action] === true : held.entries.some(entry => entry.domain === need.domain &&
        (entry.level === need.level || need.level === "view" && ["edit", "approve", "export"].includes(entry.level)) &&
        (!need.tenant || entry.scope.kind === "TENANT") && (!need.scopes || need.scopes.includes(entry.scope.kind)));
      const need = routes[path]!.options.staticData!.access;
      if (!need || need === "signed-in") throw new Error(`Missing guarded contract: ${path}`);
      expect(accessRefusal(held, need) === null).toBe(requirements.every(readAdmits));
    });
  }
}

test("attendance record reads use one Cedar fact snapshot; schedule keeps its projected caller", () => {
  const records = source("attendance/rest/src/records.rs");
  for (const [handler, read] of [["days", "day_board"], ["month", "month_grid"], ["person_month", "person_month"]]) {
    expect(records).toMatch(new RegExp(`async fn ${handler}[\\s\\S]*?let c = read_scope\\(&p\\)[\\s\\S]*?\\.${read}_with_access\\(&c,[\\s\\S]*?access::load!\\(org, actor\\)`));
  }
  expect(records).not.toContain("caller(&p, READ)");
  expect(source("attendance/rest/src/records_access.rs").match(/load_facts/g)).toHaveLength(1);
  expect(source("attendance/rest/src/schedule/mod.rs")).toMatch(/const READ: Feature = Feature::EmployeeDirectoryRead/);
  expect(source("attendance/rest/src/schedule/mod.rs")).toContain("if branch_ids.is_empty()");
  for (const op of routeReads["/attendance"].reads) expect(operationAccess[op]).toEqual({ domain: "hr_basic", level: "view", scopes: ["TENANT", "LEGAL_ENTITY", "WORKPLACE"] });
});

test("the exit list uses the existing branch capability gate, including its department refusal", () => {
  expect(source("hr/adapter-postgres/src/exits/queries_service.rs")).toMatch(/fn list_exit_cases[\s\S]*?authorize_hr_scoped\(&principal, Feature::EmployeeDirectoryRead\)/);
  expect(source("hr/adapter-postgres/src/authz.rs")).toMatch(/fn authorize_hr_scoped[\s\S]*?authorize_capability\(principal, action\)/);
  expect(operationAccess["GET /api/v1/hr/exit-cases"]).toEqual({ domain: "hr_basic", level: "view", scopes: operationAccess["GET /api/v1/attendance/month"].scopes });
});

test("org reads use entity reach or the branch-less capability floor; neither widens a department", () => {
  expect(source("entity/rest/src/auth.rs")).toMatch(/Need::Read => Feature::OrgChangeRead/);
  expect(source("entity/rest/src/handlers.rs")).toMatch(/fn list_entities[\s\S]*?Need::Read, Target::Tenant/);
  expect(source("orgchange/rest/src/org_units.rs")).toMatch(/fn list_org_units[\s\S]*?allow_read\(&p\)/);
  expect(source("orgchange/rest/src/access.rs")).toMatch(/authorize_capability\(p, Action::new\(feature\)\)/);
  expect(source("platform/authz/src/decide.rs")).toContain("if principal.branch_scope.is_empty()");
  for (const op of ["GET /api/v1/legal-entities", "GET /api/v1/org-structure", "GET /api/v1/org-changes", "GET /api/v1/org-structure/batches"] as const) {
    expect(operationAccess[op]).toEqual({ domain: "org", level: "view", scopes: ["TENANT", "LEGAL_ENTITY", "WORKPLACE"] });
  }
});

test("payroll read allow-list expires as soon as S1a generates its Cedar metadata", () => {
  for (const op of Object.keys(pendingPayrollReads)) expect(operationAccess).not.toHaveProperty(op);
});
