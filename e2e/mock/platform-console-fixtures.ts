// SPDX-License-Identifier: LicenseRef-Proprietary
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { Page } from "@playwright/test";
import type { components } from "@console/api";
import { EXPERIENCE_KEY, THEME_KEY } from "../../apps/web/src/lib/prefs";
import type {
  EraseRead, Group, GroupRole, Health, OperatorSummary, OpsRecoveryRead, Org, SupportSessionMetadata, TenantRole,
} from "../../apps/web/src/features/platform/api";
import { expectAxe, fits } from "../a11y";
import { AT, failure, id, token, user } from "./fixtures";
import { mockRoute } from "./route";
import { mockScreen } from "./screen";
import { screens } from "../states/registry";
import saeon from "./saeon-universe.json" with { type: "json" };

const SHOT_DIR = process.env.CONSOLE_SHOT_DIR ?? process.env.STRUCT_SHOTS ?? "";
const CAPTURE = Boolean(SHOT_DIR);
export const OPERATOR_NAME = `${saeon.namePools.surnamesBeforeWindow[13]}${saeon.namePools.givenNames[53]}`;
export const ME_ID = user.id;
export const PEER_ID = id(2);
export const THIRD_ID = id(3);
export const SUP_1 = "40100000-0000-4000-8000-000000000401";
export const SUP_2 = "40200000-0000-4000-8000-000000000402";
export const SUP_3 = "40300000-0000-4000-8000-000000000403";

const orgRow = (
  n: number,
  name: string,
  slug: string,
  status: Org["status"],
  lifecycle: Org["lifecycle"],
  passkey: number,
  issued: number,
  created_at: string,
  group?: { id: string; slug: string; name: string },
  pending_domain: string | null = null,
): Org => ({
  id: id(n), name, slug, group_id: group?.id ?? null, group_slug: group?.slug ?? null, group_name: group?.name ?? null,
  status, lifecycle, passkey_registered_count: passkey, code_issued_count: issued, pending_domain, created_at, updated_at: AT,
});

export const makeOrgs = (): Org[] => {
  const g1 = { id: id(201), slug: "saeon-group", name: "Saeon Industrial Group" };
  return [
    orgRow(101, "Saeon Precision Co.", "saeon-precision", "ACTIVE", "OPERATING", 14, 18, "2026-01-12T03:00:00Z", g1),
    orgRow(102, "Hanul Logistics Ltd.", "hanul-logistics", "ACTIVE", "CODE_ISSUED", 0, 1, "2026-05-04T06:30:00Z", g1, "hr.hanul.example"),
    orgRow(103, "Northstar Bio Labs", "northstar-bio", "SUSPENDED", "SETUP", 6, 7, "2026-03-19T02:15:00Z"),
    orgRow(104, "BluePeak Retail", "bluepeak-retail", "ARCHIVED", "ENROLLED", 2, 4, "2025-11-08T01:00:00Z"),
    orgRow(105, "Harbor Cloud Inc.", "harbor-cloud", "ACTIVE", "OPERATING", 5, 6, "2026-06-01T01:00:00Z"),
  ];
};

const makeHealth = (): Health[] => [
  { id: id(101), slug: "saeon-precision", name: "Saeon Precision Co.", status: "ACTIVE", group_id: id(201), group_slug: "saeon-group", group_name: "Saeon Industrial Group", user_count: 14, active_user_count: 14, active_work_orders: 1, open_work_orders: 1, zero_legacy_release_cycles: 3, route_adoption: [], last_activity_at: AT },
  { id: id(102), slug: "hanul-logistics", name: "Hanul Logistics Ltd.", status: "ACTIVE", group_id: id(201), group_slug: "saeon-group", group_name: "Saeon Industrial Group", user_count: 1, active_user_count: 0, active_work_orders: 0, open_work_orders: 0, zero_legacy_release_cycles: 0, route_adoption: [], last_activity_at: AT },
  { id: id(103), slug: "northstar-bio", name: "Northstar Bio Labs", status: "SUSPENDED", group_id: null, group_slug: null, group_name: null, user_count: 6, active_user_count: 6, active_work_orders: 0, open_work_orders: 0, zero_legacy_release_cycles: 1, route_adoption: [], last_activity_at: AT },
  { id: id(104), slug: "bluepeak-retail", name: "BluePeak Retail", status: "ARCHIVED", group_id: null, group_slug: null, group_name: null, user_count: 2, active_user_count: 2, active_work_orders: 0, open_work_orders: 0, zero_legacy_release_cycles: 0, route_adoption: [], last_activity_at: AT },
  { id: id(105), slug: "harbor-cloud", name: "Harbor Cloud Inc.", status: "ACTIVE", group_id: null, group_slug: null, group_name: null, user_count: 5, active_user_count: 5, active_work_orders: 2, open_work_orders: 2, zero_legacy_release_cycles: 2, route_adoption: [], last_activity_at: AT },
];

const makeGroups = (): Group[] => [
  {
    id: id(201), name: "Saeon Industrial Group", slug: "saeon-group", status: "ACTIVE", member_count: 2,
    members: [
      { id: id(101), name: "Saeon Precision Co.", slug: "saeon-precision", status: "ACTIVE" },
      { id: id(102), name: "Hanul Logistics Ltd.", slug: "hanul-logistics", status: "ACTIVE" },
    ],
    created_at: "2026-01-10T01:00:00Z", updated_at: AT,
  },
  { id: id(202), name: "Vanguard Holdings", slug: "vanguard-holdings", status: "SUSPENDED", member_count: 0, members: [], created_at: "2026-04-02T01:00:00Z", updated_at: AT },
];

export const makeOperators = (): OperatorSummary[] => [
  { user_id: ME_ID, display_name: "Jiwon Seo (Primary)", sign_in_id: "jiwon.seo@platform.test", status: "ACTIVE", is_active: true, has_passkey: true, device_bound_passkey: true, invite_expires_at: null, created_at: "2026-01-02T00:00:00Z" },
  { user_id: PEER_ID, display_name: "Minho Kang (Reviewer)", sign_in_id: "minho.kang@platform.test", status: "ACTIVE", is_active: true, has_passkey: true, device_bound_passkey: true, invite_expires_at: null, created_at: "2026-01-05T00:00:00Z" },
  { user_id: THIRD_ID, display_name: "Yuna Cho (Onboard)", sign_in_id: "yuna.cho@platform.test", status: "PENDING_ENROLMENT", is_active: true, has_passkey: false, device_bound_passkey: false, invite_expires_at: "2026-12-30T09:00:00Z", created_at: AT },
];

const makeSupportSessions = (): SupportSessionMetadata[] => [
  { id: SUP_1, org_id: id(101), operator_ref: PEER_ID, operator_approver_ref: null, state: "REQUESTED", scope: ["org", "hr_basic"], requested_duration_seconds: 1800, tenant_approved: false, requested_at: AT, request_expires_at: "2026-12-20T09:00:00Z", expires_at: null },
  { id: SUP_2, org_id: id(101), operator_ref: ME_ID, operator_approver_ref: PEER_ID, state: "OPERATOR_APPROVED", scope: ["org"], requested_duration_seconds: 3600, tenant_approved: true, requested_at: "2026-10-25T09:00:00Z", request_expires_at: "2026-12-20T09:00:00Z", expires_at: null },
  { id: SUP_3, org_id: id(101), operator_ref: ME_ID, operator_approver_ref: PEER_ID, state: "ACTIVE", scope: ["org", "hr_basic"], requested_duration_seconds: 1800, tenant_approved: true, requested_at: "2026-10-26T08:00:00Z", request_expires_at: "2026-12-20T09:00:00Z", expires_at: "2099-01-01T00:00:00Z" },
];

export async function setupPlatformMocks(
  page: Page,
  options?: {
    emptyOrgs?: boolean;
    cancelPasskey?: boolean;
    eraseOverride?: (orgId: string) => EraseRead;
    recoveryOverride?: (orgId: string) => OpsRecoveryRead;
  },
) {
  await page.addInitScript(([expKey, cancel]) => {
    localStorage.setItem(expKey!, "console");
    Object.defineProperty(navigator.credentials, "get", {
      configurable: true,
      value: async (opts?: { mediation?: string }) => {
        if (opts?.mediation === "conditional") return new Promise(() => {});
        return cancel ? null : { toJSON: () => ({ id: "plat-cred-1" }) };
      },
    });
  }, [EXPERIENCE_KEY, Boolean(options?.cancelPasskey)] as const);

  const fixture = await mockScreen(page, screens[0], "populated");
  const auth = token();
  const [header, payload, signature] = auth.access_token.split(".");
  const claims = { ...JSON.parse(Buffer.from(payload!, "base64url").toString()), platform: true, sub: ME_ID, name: OPERATOR_NAME };
  auth.access_token = `${header}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${signature}`;
  await mockRoute(page, "post", "/api/v1/auth/token/refresh", { status: 200, json: auth });

  type StepUpBinding = components["schemas"]["MobilePasskeyStepUpEnvelope"]["binding"];
  const stepUps: Array<{ binding?: Partial<StepUpBinding> }> = [];
  await mockRoute(page, "post", "/api/v1/auth/passkey/login/start", () => {
    stepUps.push({ binding: { action_kind: "UNBOUND" } });
    return { status: 200, json: { ceremony_id: `plat-login-step-up-${stepUps.length}`, challenge: { publicKey: { challenge: "Y2hhbGxlbmdl" } }, expires_at: AT } };
  });
  await mockRoute(page, "post", "/api/v1/auth/passkey/step-up/start", (request) => {
    const body = request.postDataJSON() as { binding?: StepUpBinding } | null;
    const binding = body?.binding ?? { action_kind: "OPERATOR_RECOVERY", object_id: ME_ID, reason_key: "passkey_step_up_operator_recovery", replay_attempt: null };
    stepUps.push({ binding });
    return { status: 200, json: { ceremony_id: `plat-step-up-${stepUps.length}`, challenge: { publicKey: { challenge: "Y2hhbGxlbmdl" } }, expires_at: AT, binding } };
  });

  const orgs = options?.emptyOrgs ? [] : makeOrgs();
  const health = makeHealth(), groups = makeGroups(), operators = makeOperators(), sessions = makeSupportSessions();
  type GroupAccount = components["schemas"]["PlatformGroupAccount"];
  const groupAccounts: Record<string, GroupAccount[]> = {
    [id(201)]: [{ user_id: id(301), org_id: id(101), org_slug: "saeon-precision", org_name: "Saeon Precision Co.", display_name: "Hyunwoo Park", phone: "010-2222-3333", account_status: "ACTIVE", is_active: true, has_passkey: true, tenant_roles: ["ADMIN"], group_roles: ["GROUP_ADMIN", "GROUP_FINANCE"], created_at: AT }],
  };

  await mockRoute(page, "get", "/api/platform/orgs", () => ({ status: 200, json: orgs }));
  await mockRoute(page, "post", "/api/platform/orgs", (request) => {
    const body = request.postDataJSON() as { name: string; slug: string };
    const created = orgRow(199, body.name, body.slug, "ACTIVE", "OPENED", 0, 1, AT);
    orgs.unshift(created);
    return { status: 201, json: { org: created, admin_user_id: id(10), otp: "ABC1234567", admin_otp_expires_at: AT, admin_sign_in_id: `admin@${body.slug}.test` } };
  });
  await mockRoute(page, "patch", "/api/platform/orgs/{id}", (request) => {
    const body = request.postDataJSON() as { status?: Org["status"]; slug?: string };
    const target = orgs.find((o) => o.id === new URL(request.url()).pathname.split("/").at(-1)!);
    if (!target) return { status: 404, json: failure("not_found") };
    if (body.status) target.status = body.status;
    if (body.slug) target.slug = body.slug;
    return { status: 200, json: target };
  });
  await mockRoute(page, "delete", "/api/platform/orgs/{id}", () => ({ status: 204, body: "" }));
  await mockRoute(page, "post", "/api/platform/orgs/{id}/admin-otp", () => ({ status: 200, json: { admin_user_id: id(10), otp: "REISSUE999", admin_otp_expires_at: AT, admin_sign_in_id: "admin@saeon-precision.test" } }));
  await mockRoute(page, "get", "/api/platform/ops", () => ({ status: 200, json: { tenants: options?.emptyOrgs ? [] : health, notices: [] } }));
  await mockRoute(page, "get", "/api/platform/company-domain", { status: 200, json: { available: true, alias_days: 7 } });
  await mockRoute(page, "get", "/api/platform/support-references/{reference}", (request) => {
    const ref = new URL(request.url()).pathname.split("/").at(-1)!;
    return { status: 200, json: { support_ref: ref, trace_id: `trace-${ref}`, release: "v2026.11.22", route_template: "/api/platform/support-sessions", org_id: id(101), support_ref_at: AT } };
  });
  await mockRoute(page, "get", "/api/platform/orgs/{id}/erase", (request) => {
    const orgId = new URL(request.url()).pathname.split("/").at(-2)!;
    if (options?.eraseOverride) return { status: 200, json: options.eraseOverride(orgId) };
    return { status: 200, json: { archived: orgs.find((o) => o.id === orgId)?.status === "ARCHIVED", legal_hold: false, second_operator_available: true, cooling_hours: 72, request: null } };
  });
  await mockRoute(page, "get", "/api/platform/orgs/{id}/ops-recovery", (request) => {
    const orgId = new URL(request.url()).pathname.split("/").at(-2)!;
    if (options?.recoveryOverride) return { status: 200, json: options.recoveryOverride(orgId) };
    return { status: 200, json: { state: null, recovery_available: true, ops_has_passkey: true, ops_enrolled: true, second_operator_available: true, active_accounts: 2, hold_hours: 24, code_ttl_minutes: 15, request: null } };
  });

  if (!options?.emptyOrgs) {
    await mockRoute(page, "get", "/api/platform/groups", () => ({ status: 200, json: groups }));
    await mockRoute(page, "post", "/api/platform/groups", (request) => {
      const body = request.postDataJSON() as { name: string; slug: string };
      const created: Group = { id: id(299), name: body.name, slug: body.slug, status: "ACTIVE", member_count: 0, members: [], created_at: AT, updated_at: AT };
      groups.push(created);
      groupAccounts[created.id] = [];
      return { status: 201, json: created };
    });
    await mockRoute(page, "patch", "/api/platform/groups/{id}", (request) => {
      const body = request.postDataJSON() as Partial<Group>;
      const g = groups.find((item) => item.id === new URL(request.url()).pathname.split("/").at(-1)!);
      if (!g) return { status: 404, json: failure("not_found") };
      if (body.name) g.name = body.name;
      if (body.slug) g.slug = body.slug;
      if (body.status) g.status = body.status;
      return { status: 200, json: g };
    });
    await mockRoute(page, "put", "/api/platform/groups/{id}/organizations/{org_id}", (request) => {
      const parts = new URL(request.url()).pathname.split("/");
      const g = groups.find((item) => item.id === parts.at(-3)!);
      const o = orgs.find((item) => item.id === parts.at(-1)!);
      if (!o) return { status: 404, json: failure("not_found") };
      if (g && !g.members.some((m) => m.id === o.id)) {
        g.members.push({ id: o.id, name: o.name, slug: o.slug, status: o.status });
        g.member_count = g.members.length;
        o.group_id = g.id;
        o.group_slug = g.slug;
        o.group_name = g.name;
      }
      return { status: 200, json: o };
    });
    await mockRoute(page, "delete", "/api/platform/groups/{id}/organizations/{org_id}", (request) => {
      const parts = new URL(request.url()).pathname.split("/");
      const g = groups.find((item) => item.id === parts.at(-3)!);
      const o = orgs.find((item) => item.id === parts.at(-1)!) ?? orgs[0]!;
      if (g) { g.members = g.members.filter((m) => m.id !== o.id); g.member_count = g.members.length; }
      return { status: 200, json: o };
    });
    await mockRoute(page, "post", "/api/platform/groups/{id}/invitations", (request) => {
      const parts = new URL(request.url()).pathname.split("/");
      const g = groups.find((item) => item.id === parts.at(-2)!);
      const body = request.postDataJSON() as { org_id: string };
      const o = orgs.find((item) => item.id === body.org_id);
      if (!g || !o) return { status: 404, json: failure("not_found") };
      const created = {
        id: id(288),
        group_id: g.id,
        group_slug: g.slug,
        group_name: g.name,
        org_id: o.id,
        org_slug: o.slug,
        org_name: o.name,
        status: "PENDING" as const,
        requested_at: AT,
        expires_at: "2026-12-05T09:00:00Z",
      };
      g.pending_invitations = [...(g.pending_invitations ?? []), created];
      return { status: 201, json: created };
    });
    await mockRoute(page, "delete", "/api/platform/groups/{id}/invitations/{invitation_id}", (request) => {
      const parts = new URL(request.url()).pathname.split("/");
      const g = groups.find((item) => item.id === parts.at(-3)!);
      const invId = parts.at(-1)!;
      if (g) g.pending_invitations = (g.pending_invitations ?? []).filter((item) => item.id !== invId);
      return { status: 204, body: "" };
    });
    await mockRoute(page, "get", "/api/platform/groups/{id}/accounts", (request) => ({ status: 200, json: groupAccounts[new URL(request.url()).pathname.split("/").at(-2)!] ?? [] }));
    await mockRoute(page, "post", "/api/platform/groups/{id}/accounts", (request) => {
      const gid = new URL(request.url()).pathname.split("/").at(-2)!;
      const body = request.postDataJSON() as { org_id: string; display_name: string; phone?: string | null; tenant_roles: TenantRole[]; group_role: GroupRole };
      const org = orgs.find((o) => o.id === body.org_id);
      const account: GroupAccount = { user_id: id(399), org_id: body.org_id, org_slug: org?.slug ?? "saeon-precision", org_name: org?.name ?? "Saeon Precision Co.", display_name: body.display_name, phone: body.phone ?? null, account_status: "ACTIVE", is_active: true, has_passkey: false, tenant_roles: body.tenant_roles, group_roles: [body.group_role], created_at: AT };
      groupAccounts[gid] = [...(groupAccounts[gid] ?? []), account];
      return { status: 201, json: { account, otp: "GRP9988776", otp_expires_at: AT } };
    });
    await mockRoute(page, "delete", "/api/platform/groups/{id}/accounts/{user_id}/roles/{group_role}", (request) => {
      const parts = new URL(request.url()).pathname.split("/");
      const gid = parts.at(-5)!, uid = parts.at(-3)!, role = parts.at(-1)!;
      groupAccounts[gid] = (groupAccounts[gid] ?? []).map((acct) => acct.user_id === uid ? { ...acct, group_roles: acct.group_roles.filter((r) => r !== role) } : acct);
      return { status: 204, body: "" };
    });
  }

  await mockRoute(page, "get", "/api/platform/operators", () => ({ status: 200, json: operators }));
  await mockRoute(page, "post", "/api/platform/operators", (request) => {
    const body = request.postDataJSON() as { id: string; display_name: string; login?: string };
    const created: OperatorSummary = { user_id: body.id, display_name: body.display_name, sign_in_id: body.login ?? null, status: "PENDING_ENROLMENT", is_active: true, has_passkey: false, device_bound_passkey: false, invite_expires_at: "2026-12-31T09:00:00Z", created_at: AT };
    operators.push(created);
    return { status: 201, json: { operator: created, invite_token: "cop_InviteToken01", expires_at: "2026-12-31T09:00:00Z" } };
  });
  await mockRoute(page, "post", "/api/platform/operators/{id}/reissue", (request) => {
    const operator = operators.find((o) => o.user_id === new URL(request.url()).pathname.split("/").at(-2)!) ?? operators[2]!;
    return { status: 200, json: { operator, invite_token: "cop_ReissuedToken02", expires_at: "2026-12-31T12:00:00Z" } };
  });
  await mockRoute(page, "post", "/api/platform/operators/{id}/revoke", (request) => {
    const target = operators.find((o) => o.user_id === new URL(request.url()).pathname.split("/").at(-2)!);
    if (target) { target.status = "REVOKED"; target.is_active = false; }
    return { status: 200, json: target ?? operators[1]! };
  });

  await mockRoute(page, "get", "/api/platform/support-sessions", (request) => {
    const orgId = new URL(request.url()).searchParams.get("org_id");
    return { status: 200, json: { sessions: sessions.filter((s) => !orgId || s.org_id === orgId) } };
  });
  await mockRoute(page, "post", "/api/platform/support-sessions", (request) => {
    const body = request.postDataJSON() as { id: string; org_id: string; scope: string[]; duration_seconds: number };
    const created: SupportSessionMetadata = { id: body.id, org_id: body.org_id, operator_ref: ME_ID, operator_approver_ref: null, state: "REQUESTED", scope: body.scope as SupportSessionMetadata["scope"], requested_duration_seconds: body.duration_seconds, tenant_approved: false, requested_at: AT, request_expires_at: "2026-12-20T09:00:00Z", expires_at: null };
    sessions.unshift(created);
    return { status: 201, json: { id: created.id, state: created.state, request_expires_at: created.request_expires_at ?? AT } };
  });
  await mockRoute(page, "post", "/api/platform/support-sessions/{id}/approve", (request) => {
    const sid = new URL(request.url()).pathname.split("/").at(-2)!;
    const item = sessions.find((s) => s.id === sid);
    if (item) { item.state = "OPERATOR_APPROVED"; item.operator_approver_ref = ME_ID; }
    return { status: 200, json: { id: sid, state: "OPERATOR_APPROVED" } };
  });
  await mockRoute(page, "post", "/api/platform/support-sessions/{id}/start", (request) => {
    const sid = new URL(request.url()).pathname.split("/").at(-2)!;
    const item = sessions.find((s) => s.id === sid);
    if (item) { item.state = "ACTIVE"; item.expires_at = "2099-01-01T00:00:00Z"; }
    return { status: 200, json: { id: sid, access_token: "sup_bearer_once_secret_token", token_type: "Bearer", expires_at: "2099-01-01T00:00:00Z" } };
  });
  await mockRoute(page, "post", "/api/platform/support-sessions/{id}/end", (request) => {
    const item = sessions.find((s) => s.id === new URL(request.url()).pathname.split("/").at(-2)!);
    if (item) item.state = "ENDED";
    return { status: 200, json: { ended: true } };
  });

  return { fixture, stepUps, orgs, groups, operators, sessions };
}

export async function applyThemeAndCheck(page: Page, screen: string, width: 1440 | 390) {
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.evaluate(([value, key]) => { localStorage.setItem(key!, value!); document.documentElement.dataset.theme = value!; }, [theme, THEME_KEY] as const);
    await page.waitForTimeout(80);
    await fits(page, `${screen}/${width}/${theme}`);
    await expectAxe(page, `${screen}/${width}/${theme}`);
    if (CAPTURE) {
      const dir = resolve(SHOT_DIR, String(width));
      mkdirSync(dir, { recursive: true });
      await page.screenshot({ path: resolve(dir, `${screen}-${theme}.png`), fullPage: true });
    }
  }
}
