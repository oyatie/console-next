// SPDX-License-Identifier: LicenseRef-Proprietary
import { installFaultClock } from "./fault-clock";
import type { Page } from "@playwright/test";
import type { components } from "@console/api";
import { mockScreen } from "../mock/screen";
import { mockRoute } from "../mock/route";
import { AT, LONG_NAME, checklist, failure, id, screenAccess, user } from "../mock/fixtures";
import { screens, type State } from "./registry";

type S = components["schemas"];
export const accessPerson = ({ id, display_name, sign_in_id = null, employee_id, employee_name, employee_number,
  employee_company, employee_org_unit, employee_link_status, roles, branch_ids, is_active, is_tenant_ops,
  has_passkey, account_status }: S["UserSummary"]): S["AccessPerson"] => ({ id, display_name, sign_in_id, employee_id,
  employee_name, employee_number, employee_company, employee_org_unit, employee_link_status, roles, branch_ids,
  is_active, is_tenant_ops, has_passkey, account_status });
/** A realistic tenant role name (~13 characters): the 1440 table shows it whole. */
const REALISTIC_ROLE = "늘봄정밀 인사 실무 담당";
export const accessRole: S["AccessRole"] = { id: id(10), name_ko: "인사 조회", status: "ACTIVE", version: 2,
  holder_count: 3, created_at: AT, updated_at: AT, lines: [{ domain: "hr_basic", levels: ["view"] }] };
const states = ["empty", "loading", "failed", "refused", "populated", "long", "large"] as const satisfies readonly State[];
export const accessScreens = [
  { module: "settings-access", coverage: ["DEPTH:acc", "COV", "STATE"], key: "access-grants", path: "/access/grants", read: "/api/v1/access/grants", states, registry: "access-grants--grant-lines", live: "e2e/access-roles.spec.ts" },
  { module: "settings-access", coverage: ["DEPTH:acc", "COV", "STATE"], key: "access-roles", path: "/access/roles", read: "/api/v1/access/roles", states, registry: "access-roles--roles-list-with-holder-counts", live: "e2e/access-roles.spec.ts" },
  { module: "settings-access", coverage: ["DEPTH:acc", "COV", "STATE"], key: "access-bulk", path: "/access/grants/bulk", read: "/api/v1/users", states, registry: "access-grants--bulk", live: "e2e/states/access.spec.ts" },
  { module: "settings-access", coverage: ["DEPTH:acc", "COV", "STATE"], key: "access-ready", path: "/access/ready", read: "/api/v1/access/grants", states, registry: "access-ready--go-live", live: "e2e/states/access.spec.ts" },
  { module: "settings-access", coverage: ["DEPTH:acc", "COV", "STATE"], key: "access-role-new", path: "/access/roles/new", read: "/api/v1/access/catalog", states, registry: "access-roles--new", live: "e2e/states/access.spec.ts" },
  { module: "settings-access", coverage: ["DEPTH:acc", "COV", "STATE"], key: "access-role-edit", path: `/access/roles/${id(10)}`, read: "/api/v1/access/roles/{roleId}", states, registry: "access-roles--editor", live: "e2e/states/access.spec.ts" },
  { module: "settings-access", coverage: ["DEPTH:acc", "COV", "STATE"], key: "access-person", path: `/access/people/${id(100)}`, read: "/api/v1/access/people/{id}", states, registry: "access-people--detail", live: "e2e/states/access.spec.ts" },
  { module: "settings-access", coverage: ["DEPTH:acc", "COV", "STATE"], key: "access-ops-person", path: `/access/people/${id(20)}`, read: "/api/v1/access/ops-usage", states, registry: "access-people--ops", live: "e2e/states/access.spec.ts" },
] as const;
type AccessScreen = typeof accessScreens[number];

export async function mockAccessScreen(page: Page, screen: AccessScreen, state: State, phase: "SETUP" | "OPERATING" = "OPERATING") {
  if (state === "failed") await installFaultClock(page);
  // shortcut: reuse the registered empty shell until UI-DECOUPLE adds accessScreens to the shared Screen union.
  const shell = await mockScreen(page, screens[0], "empty");
  const count = state === "empty" ? 0 : state === "large" ? 2000 : 3;
  const accounts: S["UserSummary"][] = Array.from({ length: count }, (_, i) => ({ ...user,
    id: id(100 + i), display_name: state === "long" ? `${LONG_NAME} ${i + 1}` : `검증직원 ${i + 1}`,
    employee_number: `ACC-${String(i + 1).padStart(4, "0")}`, employee_name: `검증직원 ${i + 1}`,
    sign_in_id: `worker${i + 1}@example.test`,
  }));
  const grants: S["AccessGrant"][] = accounts.map(account => ({ id: id(3000 + Number(account.employee_number!.slice(4))),
    account_id: account.id, account_display_name: account.display_name, account_employee_number: account.employee_number,
    account_active: true, account_has_passkey: true, role_id: accessRole.id, role_name_ko: state === "long" ? LONG_NAME : state === "populated" ? REALISTIC_ROLE : accessRole.name_ko,
    scope: { kind: "TENANT", include_descendants: true }, valid_from: AT, valid_to: "2027-01-01T00:00:00Z",
    effective_in_setup: false, enforcement: phase === "SETUP" ? "PREPARED" : "ENFORCED",
    reason_code: "OTHER", granted_by: user.id, granted_at: AT,
  }));
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const beforeReply = async (path: AccessScreen["read"]) => {
    if (path !== screen.read) return null;
    if (state === "loading") await held;
    return state === "failed" ? { status: 503 as const, json: failure("service_unavailable") }
      : state === "refused" ? { status: 403 as const, json: failure("forbidden") } : null;
  };
  await mockRoute(page, "get", "/api/v1/users/me", { status: 200, json: { ...user, tenant: { ...user.tenant!, phase } } });
  await mockRoute(page, "get", "/api/v1/onboarding/checklist", { status: 200, json: { ...checklist, phase } });
  await mockRoute(page, "get", "/api/v1/access/me", { status: 200, json: screenAccess(screen.path, phase) });
  await mockRoute(page, "get", "/api/v1/access/ops", { status: 200, json: { account_id: id(20), display_name: "운영 계정" } });
  await mockRoute(page, "get", "/api/v1/access/ops-usage", async () => (await beforeReply("/api/v1/access/ops-usage")) ?? {
    status: 200,
    json: state === "empty" ? [] : [{ at: AT, account_id: id(20), method: "POST", path: "/api/v1/payroll/runs/1/lock" }],
  });
  await mockRoute(page, "get", "/api/v1/access/catalog", async () => (await beforeReply("/api/v1/access/catalog")) ?? { status: 200, json: {
    domains: [
      { domain: "hr_basic", grantable: true, levels: ["view", "edit"] as ("view" | "edit")[], operations: [{ operation: "employee.update", level: "edit" as const }] },
      { domain: "pay", grantable: true, levels: ["view"] as ("view")[], operations: [] },
    ],
    levels: ["view", "edit"] as ("view" | "edit")[], scope_kinds: [{ kind: "TENANT" as const, enforceable: true, descendants_only: true }], reason_domain: "role_change" as const,
  } });
  await mockRoute(page, "get", "/api/v1/access/requests", { status: 200, json: [] });
  await mockRoute(page, "get", "/api/v1/reason-codes", { status: 200, json: { domain: "role_change", items: [{ code: "OTHER", system: true, requires_note: false, involuntary: false, notice_required: false, active: true, label_ko: "Other", label_en: "Other" }] } });
  await mockRoute(page, "get", "/api/v1/users", async request => {
    const failed = await beforeReply("/api/v1/users");
    if (failed) return failed;
    const query = new URL(request.url()).searchParams;
    const q = (query.get("search") ?? query.get("q"))?.toLowerCase() ?? "";
    const matches = accounts.filter(a => [a.display_name, a.employee_name, a.employee_number, a.sign_in_id].some(value => value?.toLowerCase().includes(q)));
    const limit = Number(query.get("limit") ?? 200), offset = Number(query.get("offset") ?? 0);
    return { status: 200, json: { items: matches.slice(offset, offset + limit), total: matches.length, limit, offset } };
  });
  await mockRoute(page, "get", "/api/v1/access/people/{id}", async request => {
    const failed = await beforeReply("/api/v1/access/people/{id}");
    if (failed) return failed;
    const accountId = new URL(request.url()).pathname.split("/").at(-1);
    const account = accountId === id(20) ? { ...user, id: id(20), display_name: "운영 계정", is_tenant_ops: true } : accounts.find(a => a.id === accountId);
    return account ? { status: 200, json: accessPerson(account) } : { status: 404, json: failure("not_found") };
  });
  await mockRoute(page, "get", "/api/v1/access/accounts/{accountId}/effective", request => {
    const accountId = new URL(request.url()).pathname.split("/").at(-2) ?? id(100);
    return { status: 200, json: { ...screenAccess(`/access/people/${accountId}`, phase), account_id: accountId, is_ops: accountId === id(20) } };
  });
  await mockRoute(page, "get", "/api/v1/access/roles", async () => (await beforeReply("/api/v1/access/roles")) ?? { status: 200, json: count ? [{ ...accessRole, holder_count: count, name_ko: state === "long" ? LONG_NAME : accessRole.name_ko }] : [] });
  await mockRoute(page, "get", "/api/v1/access/roles/{roleId}", async () => (await beforeReply("/api/v1/access/roles/{roleId}")) ?? {
    status: 200,
    json: { ...accessRole, holder_count: count, name_ko: state === "long" ? LONG_NAME : accessRole.name_ko },
  });
  await mockRoute(page, "get", "/api/v1/access/roles/{roleId}/versions", {
    status: 200,
    json: [
      { version: 2, name_ko: accessRole.name_ko, description: null, status: "ACTIVE" as const, change_mode: "OPERATING" as const, lines: [{ domain: "hr_basic", levels: ["view", "edit"] as ("view" | "edit")[] }], created_at: AT, created_by: user.id, reason_code: "OTHER" },
      { version: 1, name_ko: accessRole.name_ko, description: null, status: "ACTIVE" as const, change_mode: "OPERATING" as const, lines: [{ domain: "hr_basic", levels: ["view"] as ("view")[] }], created_at: AT, created_by: user.id, reason_code: null },
    ],
  });
  await mockRoute(page, "get", "/api/v1/access/grants", async request => {
    const query = new URL(request.url()).searchParams;
    const items = grants.filter(g => !query.has("role_id") || g.role_id === query.get("role_id"));
    return (await beforeReply("/api/v1/access/grants")) ?? { status: 200, json: items };
  });
  return { ...shell, count, accounts, grants, release: () => { release(); shell.release(); } };
}
