// SPDX-License-Identifier: LicenseRef-Proprietary
import type { Page } from "@playwright/test";
import type { components } from "@console/api";
import { AT, id, screenAccess, structure, user } from "./fixtures";
import { mockRoute } from "./route";
import { orgChanges } from "./org-changes";
/** Work-page supporting reads; the shared screen factory owns the shell and primary read failures. */
export async function orgWorkReads(page: Page, state: string) {
  const tree = structure(state === "empty" ? 0 : 3);
  tree.phase = state === "operating" ? "OPERATING" : "SETUP";
  await mockRoute(page, "get", "/api/v1/access/me", request => ({ status: 200,
    json: screenAccess(new URL(request.headers().referer ?? request.url()).pathname, tree.phase),
  }));
  if (state !== "loading" && state !== "failed" && state !== "refused") {
    await mockRoute(page, "get", "/api/v1/org-structure", { status: 200, json: tree });
  }
  return { tree, workplaceId: id(4) };
}

/** Panel and sheet reads use the same org screen and shell as the work-page matrix. */
export async function orgPanelReads(page: Page, blocked = false, pending = false) {
  type S = components["schemas"];
  const tree = structure(3);
  const dept = tree.entities[0]!.children[0]!.children[0]!;
  const member = { employeeId: id(100), name: "검증직원 1" };
  const change = { ...orgChanges(1)[0]!, target: { kind: "ORG_UNIT" as const, ref: dept.id, label: dept.name } };
  const regular: S["RegularWorkers"] = { status: "HOLD", basis: "LSA_DECREE_7_2", missing: [], live_headcount: 0 };
  const entity: S["LegalEntity"] = {
    id: id(3), needs_confirmation: false, identity_locked: true, founding: false, can_manage: true,
    head_office_has_no_workplace: false, scheduled: [], registrations: [], regular_workers: regular,
    current: { version: 1, effective_from: "2026-01-01", before_first_record: false, name: "검증법인", additional_representatives: 0, change_mode: "GOVERNED" },
    workplaces: [{ id: id(4), legal_entity_id: id(3), registration_todo: false, can_manage: true,
      is_primary: true, is_head_office: true, needs_confirmation: false, headcount: 3, regular_workers: regular,
      withholding: { kind: "ENTITY_HEAD_OFFICE" }, insurance: [],
      current: { version: 1, effective_from: "2026-01-01", before_first_record: false, name: "본사", is_construction_site: false, status: "CONTINUING", change_mode: "GOVERNED" },
    }],
  };
  const end: S["OrgUnitEndOptions"] = { org_unit_id: dept.id, name: dept.name, version: 1, phase: "OPERATING", delete: { allowed: false, refusal: blocked ? "org_unit_change_open" : "org_unit_used" }, dissolve: { allowed: !blocked, refusal: blocked ? "org_unit_change_open" : undefined }, members: 1, people_ever: 1, units: 0, can_manage: true, held_by: blocked ? { id: change.id, code: change.code } : null };
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await mockRoute(page, "get", "/api/v1/org-structure", { status: 200, json: tree });
  await mockRoute(page, "get", "/api/v1/access/me", { status: 200, json: { account_id: user.id, is_ops: true, phase: "OPERATING", as_of: AT, entries: [] } });
  await mockRoute(page, "get", "/api/v1/org-units/{id}", { status: 200, json: { id: dept.id, kind: "DEPARTMENT", name: dept.name, parentId: id(4), status: "ACTIVE", effectiveFrom: "2026-01-01", headcount: 1, updatedAt: AT, revisions: [], members: { headcount: 1, items: [member] } } });
  await mockRoute(page, "get", "/api/v1/org-structure/units/{orgUnitId}/members", { status: 200, json: { headcount: 1, items: [member] } });
  await mockRoute(page, "get", "/api/v1/org-structure/units/{orgUnitId}/end-options", async () => { if (pending) await held; return { status: 200, json: end }; });
  await mockRoute(page, "get", "/api/v1/org-changes", { status: 200, json: { items: blocked ? [change] : [], total: blocked ? 1 : 0 } });
  await mockRoute(page, "get", "/api/v1/access/grants", { status: 200, json: [] });
  await mockRoute(page, "get", "/api/v1/legal-entities", { status: 200, json: { items: [entity] } });
  await mockRoute(page, "get", "/api/v1/legal-entities/{entityId}", { status: 200, json: entity });
  await mockRoute(page, "get", "/api/v1/workplaces/{workplaceId}/revisions", { status: 200, json: { items: [] } });
  await mockRoute(page, "get", "/api/v1/workplaces/{workplaceId}/end-options", { status: 200, json: { id: id(4), phase: "OPERATING", delete: { allowed: false }, close: { allowed: true }, can_manage: true, open_exit_cases: [] } });
  return { dept, change, release };
}
