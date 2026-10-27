// SPDX-License-Identifier: LicenseRef-Proprietary
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createRouter, type AnyRoute } from "@tanstack/react-router";
import { expect, test } from "vitest";
import { routeTree } from "./tree";
import { routeReads, readRequirement } from "./route-reads";
import { accessRefusal, type Requirement } from "../reference/authz/domain/access";
import type { AccessEffective } from "../reference/authz/api";
import { operationAccess } from "../reference/authz/domain/operation-access";

const router = createRouter({ routeTree });
const routes: Record<string, AnyRoute> = router.routesByPath;
const yaml = createRequire(import.meta.url)("js-yaml");
const spec = yaml.load(readFileSync("backend/openapi/openapi.yaml", "utf8"));
const scopeKinds: AccessEffective["entries"][number]["scope"]["kind"][] = spec.components.schemas.AccessScopeKind.enum;
const source = (file: string) => readFileSync(`backend/crates/${file}`, "utf8");

test("the table covers every guarded route exactly once", () => {
  const guarded = Object.values(routes).filter(route => route.options.staticData?.access && route.options.staticData.access !== "signed-in").map(route => route.fullPath);
  expect(Object.keys(routeReads).sort()).toEqual(guarded.sort());
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
      const requirements: Requirement[] = ops.map(op => operationAccess[op]);
      const held = { is_ops: false, entries: kind ? requirements.map((need, i) => ({ ...need, grant_id: String(i), enforcement: "ENFORCED", scope: { kind } })) : [] } as unknown as AccessEffective;
      // Independent evaluator: never call the UI decision to calculate the expected server verdict.
      const readAdmits = (need: Requirement) => held.entries.some(entry => entry.domain === need.domain &&
        (entry.level === need.level || need.level === "view" && ["edit", "approve", "export"].includes(entry.level)) &&
        (!need.tenant || entry.scope.kind === "TENANT") && (!need.scopes || need.scopes.includes(entry.scope.kind)));
      const need = routes[path]!.options.staticData!.access;
      if (!need || need === "signed-in") throw new Error(`Missing guarded contract: ${path}`);
      expect(accessRefusal(held, need) === null).toBe(requirements.every(readAdmits));
    });
  }
}

test("attendance's actual month/day/schedule handlers use the projected branch caller", () => {
  expect(source("attendance/rest/src/records.rs")).toMatch(/fn month[\s\S]*?let p = principal\(&s, &h\).await\?;\s*let c = caller\(&p, READ\)/);
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
