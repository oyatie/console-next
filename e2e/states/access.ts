// SPDX-License-Identifier: LicenseRef-Proprietary
import type { Page } from "@playwright/test";
import type { components } from "@console/api";
import { mockScreen } from "../mock/screen";
import { mockRoute } from "../mock/route";
import { AT, LONG_NAME, checklist, failure, id, screenAccess, user } from "../mock/fixtures";
import { screens, type State } from "./registry";

type S = components["schemas"];
/** A realistic tenant role name (~13 characters): the 1440 table shows it whole. */
const REALISTIC_ROLE = "늘봄정밀 인사 실무 담당";
export const accessRole: S["AccessRole"] = { id: id(10), name_ko: "인사 조회", status: "ACTIVE", version: 1,
  holder_count: 3, created_at: AT, updated_at: AT, lines: [{ domain: "hr_basic", levels: ["view"] }] };
const states = ["empty", "loading", "failed", "refused", "populated", "long", "large"] as const satisfies readonly State[];
export const accessScreens = [
  { module: "settings-access", coverage: ["DEPTH:acc", "COV", "STATE"], key: "access-grants", path: "/access/grants", read: "/api/v1/access/grants", states, registry: "access-grants--grant-lines", live: "e2e/access-roles.spec.ts" },
  { module: "settings-access", coverage: ["DEPTH:acc", "COV", "STATE"], key: "access-roles", path: "/access/roles", read: "/api/v1/access/roles", states, registry: "access-roles--roles-list-with-holder-counts", live: "e2e/access-roles.spec.ts" },
] as const;
type AccessScreen = typeof accessScreens[number];

export async function mockAccessScreen(page: Page, screen: AccessScreen, state: State, phase: "SETUP" | "OPERATING" = "OPERATING") {
  // shortcut: reuse the registered empty shell until UI-DECOUPLE adds accessScreens to the shared Screen union.
  const shell = await mockScreen(page, screens[0], "empty");
  const count = state === "empty" ? 0 : state === "large" ? 2000 : 3;
  const accounts: S["UserSummary"][] = Array.from({ length: count }, (_, i) => ({ ...user,
    id: id(100 + i), display_name: state === "long" ? `${LONG_NAME} ${i + 1}` : `검증직원 ${i + 1}`,
    employee_number: `ACC-${String(i + 1).padStart(4, "0")}`, employee_name: `검증직원 ${i + 1}`,
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
  await mockRoute(page, "get", "/api/v1/access/catalog", { status: 200, json: {
    domains: [{ domain: "hr_basic", grantable: true, levels: ["view", "edit"], operations: [] }],
    levels: ["view", "edit"], scope_kinds: [{ kind: "TENANT", enforceable: true, descendants_only: true }], reason_domain: "role_change",
  } });
  await mockRoute(page, "get", "/api/v1/access/requests", { status: 200, json: [] });
  await mockRoute(page, "get", "/api/v1/reason-codes", { status: 200, json: { domain: "role_change", items: [] } });
  // The fixture honors the proposed q contract; production keeps the current account page until that API lands.
  await mockRoute(page, "get", "/api/v1/users", request => {
    const query = new URL(request.url()).searchParams;
    const q = query.get("q")?.toLowerCase() ?? "";
    const matches = accounts.filter(a => [a.display_name, a.employee_name, a.employee_number].some(value => value?.toLowerCase().includes(q)));
    const limit = Number(query.get("limit") ?? 200), offset = Number(query.get("offset") ?? 0);
    return { status: 200, json: { items: matches.slice(offset, offset + limit), total: matches.length, limit, offset } };
  });
  await mockRoute(page, "get", "/api/v1/access/roles", async () => (await beforeReply("/api/v1/access/roles")) ?? { status: 200, json: count ? [{ ...accessRole, holder_count: count, name_ko: state === "long" ? LONG_NAME : accessRole.name_ko }] : [] });
  await mockRoute(page, "get", "/api/v1/access/grants", async request => {
    const query = new URL(request.url()).searchParams;
    const items = grants.filter(g => !query.has("role_id") || g.role_id === query.get("role_id"));
    return (await beforeReply("/api/v1/access/grants")) ?? { status: 200, json: items };
  });
  return { ...shell, count, accounts, grants, release: () => { release(); shell.release(); } };
}
