// SPDX-License-Identifier: LicenseRef-Proprietary
import type { components } from "@console/api";

type S = components["schemas"];
export const AT = "2026-10-26T09:00:00Z";
export const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
export const LONG_NAME = "한국정밀서비스 전국사업운영지원본부 인사조직관리 담당";
export const failure = (code: string): S["ErrorBody"] => ({ error: { code, message: "요청을 처리하지 못했습니다.", operation_id: id(99) } });

export const user: S["CurrentUser"] = {
  id: id(1), display_name: "김담당", employee_id: null, employee_name: null, employee_number: null,
  employee_company: null, employee_org_unit: null, employee_position: null,
  employee_identity_review_required: null, employee_identity_resolution_confidence: null,
  employee_link_status: "UNLINKED", phone: null, team: "MANAGEMENT", roles: [], branch_ids: [],
  is_active: true, is_tenant_ops: false, has_passkey: true, account_status: "ACTIVE", created_at: AT,
  tenant: { name: "화면 검증 회사", phase: "OPERATING", go_live_at: AT },
};
export const authz: S["MeAuthzResponse"] = {
  authority: "advisory_ui_only", source: "cedar", user_id: user.id, org_id: id(2), roles: [], branch_scope: { kind: "all" },
  capabilities: ["employee_directory_read", "org_change_read"].map(feature => ({ feature, permission: "allow", branch_scope: { kind: "all" }, org_wide: true, scoped: false })),
};
export const checklist: S["SetupChecklist"] = {
  phase: "OPERATING", steps: [], done: 0, total: 0, go_live_at: "2026-01-01T00:00:00Z",
  summary: { people: 0, placed: 0, unplaced: 0, entity_unknown: 0, progress: 100 },
};
export function token(): S["TokenPairResponse"] {
  const claims = { sub: user.id, org: authz.org_id, name: user.display_name, exp: Math.floor(Date.now() / 1000) + 3600 };
  return { access_token: `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.mock`, token_type: "Bearer", refresh_expires_at: "2099-01-01T00:00:00Z", requires_passkey_setup: false, privacy_consent_accepted: true };
}

export function employees(count: number, long = false): S["Employee"][] {
  return Array.from({ length: count }, (_, i) => ({
    id: id(100 + i), company: long ? LONG_NAME : "화면 검증 회사", name: long ? LONG_NAME : `검증직원 ${i + 1}`,
    employee_number: `UI-${String(i + 1).padStart(4, "0")}`, org_unit_id: null, legal_entity_id: null, workplace_id: long ? id(4) : null,
    org_unit: long ? LONG_NAME : null, position: long ? LONG_NAME : "담당",
    status: "ACTIVE", hire_date: "2026-01-01", employment_type: "REGULAR", home_branch_review_required: true,
    identity_resolution_strategy: "employee_number", identity_resolution_confidence: "high", identity_review_required: false,
    identity_name_only_merge: false, next_event: null, failed_event: null, created_at: AT, updated_at: AT,
  }));
}
export function facets(count: number): S["EmployeeFacets"] {
  return { total: count, status: [{ value: "ACTIVE", count }], employment_type: [{ value: "REGULAR", count }], legal_entity: [], workplace: [],
    review: { identity_review_required: 0, register_review_required: 0, home_branch_review_required: count, lifecycle_apply_failed: 0, contract_ended: 0, contract_ending_before: 0 } };
}

export function inbox(count: number, long = false): S["ActionInboxResponse"] {
  const items: S["ActionInboxItem"][] = Array.from({ length: count }, (_, i) => ({
    id: `contract_renewal:${id(100 + i)}`, kind: "contract_renewal", urg: "today", ref: `UI-${String(i + 1).padStart(4, "0")}`,
    title: long ? LONG_NAME : `검증직원 ${i + 1}`, site: long ? LONG_NAME : "본사", dueTone: "warn", done: false,
    links: [{ kind: "employee", id: id(100 + i) }], lane: "turn", days_remaining: 3,
  }));
  return { items, total: count, total_is_exact: true, next_cursor: null, unavailable: [],
    counts: { turn: { total: count, total_is_exact: true } }, upcoming: [], has_work: count > 0,
    quick_starts: [], as_of: AT, available_filters: ["turn"] };
}

export function structure(count: number, long = false): S["OrgStructure"] {
  const node = (kind: S["OrgStructureNode"]["kind"], n: number, name: string, children: S["OrgStructureNode"][] = []): S["OrgStructureNode"] => ({
    id: id(n), kind, name, version: 1, headcount: kind === "DEPARTMENT" ? 1 : count, direct_headcount: kind === "DEPARTMENT" ? 1 : 0,
    dispatched_headcount: 0, chips: [], children,
  });
  return { tenant_name: "화면 검증 회사", phase: "OPERATING", unplaced: [], entities: count === 0 ? [] : [
    node("LEGAL_ENTITY", 3, long ? LONG_NAME : "검증법인", [node("WORKPLACE", 4, long ? LONG_NAME : "본사", Array.from({ length: count }, (_, i) => node("DEPARTMENT", 100 + i, long ? `${LONG_NAME} ${i + 1}` : `검증부서 ${i + 1}`))) ]),
  ] };
}
