// SPDX-License-Identifier: LicenseRef-Proprietary
import type { Page } from "@playwright/test";
import type { components } from "@console/api";
import type { Screen } from "../states/registry";
import { AT, authz, employees, failure, id } from "./fixtures";
import { mockRoute } from "./route";

type S = components["schemas"];
const entityId = id(4001);
const units: S["OrgUnitHead"][] = ([
  [4002, "본사", "SITE", null], [4003, "인사팀", "DEPARTMENT", 4002],
  [4004, "부산사업장", "SITE", null], [4005, "재무팀", "DEPARTMENT", 4004],
] as const).map(([n, name, kind, parent]) => ({ id: id(n), name, kind, parentId: parent ? id(parent) : null, status: "ACTIVE", effectiveFrom: "2026-01-01", headcount: 2, updatedAt: AT }));
const regular: S["RegularWorkers"] = { status: "HOLD", basis: "LSA_DECREE_7_2", missing: [], live_headcount: 1 };
const workplaces: S["Workplace"][] = [4002, 4004].map((n) => ({
  id: id(n + 10), org_unit_id: id(n), legal_entity_id: entityId, registration_todo: false,
  is_primary: n === 4002, is_head_office: n === 4002, needs_confirmation: false, can_manage: false,
  current: { version: 1, effective_from: "2026-01-01", before_first_record: false, name: units.find(u => u.id === id(n))!.name, is_construction_site: false, status: "CONTINUING", change_mode: "SETUP" },
  insurance: [], withholding: { kind: "SELF_UNIT" }, headcount: 1, regular_workers: regular, default_branch_id: id(n + 20),
}));
const entity: S["LegalEntity"] = {
  id: entityId, needs_confirmation: false, identity_locked: true, founding: false, can_manage: false, head_office_has_no_workplace: false,
  current: { name: "화면 검증 회사", version: 1, effective_from: "2026-01-01", before_first_record: false, additional_representatives: 0, change_mode: "SETUP" },
  scheduled: [], registrations: [], workplaces, regular_workers: regular,
};
const node = (kind: S["OrgStructureNode"]["kind"], n: number, name: string, children: S["OrgStructureNode"][] = []): S["OrgStructureNode"] => ({
  id: id(n), kind, name, version: 1, headcount: 1, direct_headcount: 1, dispatched_headcount: 0, chips: [], children,
});
const moveTree: S["OrgStructure"] = { tenant_name: "화면 검증 회사", phase: "OPERATING", unplaced: [], entities: [node("LEGAL_ENTITY", 4001, "화면 검증 회사", workplaces.map(w => ({
  ...node("WORKPLACE", Number(w.id.slice(-12)), w.current!.name, units.filter(u => u.parentId === w.org_unit_id).map(u => node("DEPARTMENT", Number(u.id.slice(-12)), u.name))), org_unit_id: w.org_unit_id ?? undefined,
}))) ] };
export const unplacedTarget = {
  entity: { ...entity, workplaces: workplaces.filter(w => w.org_unit_id !== id(4004)) },
  structure: { ...moveTree, entities: [node("LEGAL_ENTITY", 4001, "화면 검증 회사", [
    moveTree.entities[0]!.children[0]!,
    node("SITE", 4004, "부산사업장", [node("DEPARTMENT", 4005, "재무팀")]),
  ])] },
};
export const moveDetail: S["EmployeeDetail"] = {
  employee: { ...employees(1)[0]!, id: id(4000), name: "배치직원", legal_entity_id: entityId, workplace_id: id(4012), org_unit_id: null, org_unit: null, home_branch_review_required: false },
  employment: { employment_type: "REGULAR", currency: "KRW" }, classification: { grade_id: null, job_title_id: null, position_kind_id: null, job_id: null, job_family_id: null },
  allowed_events: [{ event_type: "TRANSFER", required_signoffs: [] }], allowed_scheduled_events: [], schedule_after: null,
};

/** Supporting reads stay with this lane; the shared mockScreen owns the authenticated shell. */
export async function mockLifecycleSheets(page: Page, screen: Screen) {
  if (screen.key !== "lifecycle-sheet" && screen.key !== "lifecycle-menu") return;
  const onLeave = screen.key === "lifecycle-menu";
  await mockRoute(page, "get", "/api/v1/me/authz", { status: 200, json: { ...authz, capabilities: [...authz.capabilities, { feature: "employee_directory_manage", permission: "allow", branch_scope: { kind: "all" }, org_wide: true, scoped: false }] } });
  await mockRoute(page, "get", "/api/v1/employees/{id}", { status: 200, json: onLeave ? { ...moveDetail, employee: { ...moveDetail.employee, status: "ON_LEAVE" }, allowed_events: [] } : moveDetail });
  await mockRoute(page, "get", "/api/v1/org-units", { status: 200, json: { items: units } });
  await mockRoute(page, "get", "/api/v1/legal-entities", { status: 200, json: { items: [entity] } });
  await mockRoute(page, "get", "/api/v1/org-structure", { status: 200, json: moveTree });
  await mockRoute(page, "get", "/api/v1/employees/{id}/lifecycle-events", { status: 200, json: { items: [], head_version: 1, next_cursor: null } });
  await mockRoute(page, "get", "/api/v1/employment-assignments", { status: 200, json: { items: [] } });
  await mockRoute(page, "get", "/api/v1/job-titles", { status: 200, json: { items: [], can_manage: false } });
  await mockRoute(page, "get", "/api/v1/employees/{id}/contracts", { status: 200, json: { items: [] } });
  await mockRoute(page, "get", "/api/v1/hr/exit-cases", { status: 200, json: { items: [], total: 0, offset: 0, limit: 200 } });
  await mockRoute(page, "get", "/api/v1/employees/{id}/rrn", { status: 200, json: { employee_id: id(4000), recorded: false } });
  await mockRoute(page, "get", "/api/v1/lifecycle-case-templates/{key}", { status: 200, json: [] });
  await mockRoute(page, "get", "/api/v1/employees/{id}/lifecycle-cases", { status: 200, json: [] });
  await mockRoute(page, "get", "/api/v1/person-binding-reviews", { status: 200, json: { items: [], total: 0, offset: 0, limit: 100 } });
  await mockRoute(page, "get", "/api/v1/reason-codes", request => ({ status: 200, json: { domain: new URL(request.url()).searchParams.get("domain")!, items: [] } }));
  await mockRoute(page, "get", "/api/v1/employees/{id}/end-options", { status: 403, json: failure("forbidden") });
  await mockRoute(page, "get", "/api/v1/employees/{id}/personal-facts", { status: 403, json: failure("forbidden") });
  await mockRoute(page, "get", "/api/v1/employees/{id}/register-facts", { status: 403, json: failure("forbidden") });
  await mockRoute(page, "get", "/api/v1/employees/{id}/employment-facts", { status: 403, json: failure("forbidden") });
  await mockRoute(page, "get", "/api/v1/employees/{id}/records", { status: 200, json: { sections: [], items: [] } });
}
