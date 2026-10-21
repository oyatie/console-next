// Pilot roles (decision #26): tenant role CRUD, dated grants per account with a scope (preview → passkey → apply), the
// per-account effective view and the ops holder. The access paths are BE-ROLES's contract (hard/roles/pilot,
// access.contract.yaml), typed here by hand under the contract's schema names until the composed OpenAPI is regenerated
// into @console/api; then these types become aliases of components["schemas"] and nothing else changes.
import { api, assertPasskey, unwrap, type components } from "@console/api";
import { get, read, type PathPrefix } from "../../lib/query";
import { accountAccessQuery, myAccessQuery } from "../../reference/authz/api";
import type { Level } from "./domain/grid";
import type { KindRule, Scope } from "./domain/scope";

type Uuid = string;
type Ts = string;
export type Enforcement = "ENFORCED" | "PREPARED" | "SCHEDULED" | "ENDED" | "REVOKED" | "ROLE_INACTIVE";
/**
 * An effective row adds SCOPE_UNAVAILABLE (an enforced grant whose scope no longer resolves, a voided workplace) and
 * ACCOUNT_INACTIVE (a deactivated account uses nothing, people-self-46).
 */
export type EffectiveState = components["schemas"]["AccessEffectiveEntry"]["enforcement"];
export type AccessCatalogDomain = { domain: string; grantable: boolean; levels: Level[]; operations: { operation: string; level: Level }[] };
export type AccessCatalog = { domains: AccessCatalogDomain[]; levels: Level[]; scope_kinds: KindRule[]; reason_domain: "role_change" };
export type AccessRoleLine = { domain: string; levels: Level[] };
export type AccessRole = { id: Uuid; name_ko: string; name_en?: string | null; description?: string | null; status: "DRAFT" | "ACTIVE" | "RETIRED"; version: number; lines: AccessRoleLine[]; holder_count: number };
export type RoleInput = { name_ko: string; description: string | null; lines: AccessRoleLine[] };
export type AccessScope = Scope & { readonly node_name?: string | null };
export type AccessGrant = {
  id: Uuid;
  account_id: Uuid;
  account_display_name?: string | null;
  /** false: the account is deactivated and its grants grant nothing (paused, people-self-46). */
  account_active: boolean;
  account_has_passkey: boolean;
  /** The holder's unit (their record's department) and employee number, when the account is linked to one. */
  account_unit?: string | null;
  account_employee_number?: string | null;
  role_id: Uuid;
  role_name_ko: string;
  scope: AccessScope;
  valid_from: Ts;
  valid_to?: Ts | null;
  activates_at?: Ts | null;
  effective_in_setup: boolean;
  enforcement: Enforcement;
  reason_code: string;
  granted_by: Uuid;
  granted_at: Ts;
};
export type GrantOp =
  | { op: "grant"; account_id: Uuid; role_id: Uuid; scope: Scope; valid_from?: Ts; valid_to: Ts | null; effective_in_setup: boolean }
  | { op: "revoke"; grant_id: Uuid }
  | { op: "set_end"; grant_id: Uuid; valid_to: Ts | null };
export type Batch = { operations: GrantOp[]; reason_code: string; reason_note: string | null };
export type PreviewItem = { index: number; op: GrantOp["op"]; outcome: "OK" | "REFUSED"; refusal?: { code: string; message: string } | null; account_id: Uuid; enforcement_after: Enforcement | null };
export type AccessGrantPreview = { receipt_id: Uuid; phase: "SETUP" | "OPERATING"; step_up_required: boolean; items: PreviewItem[]; refused: number; accounts_affected: number };
// One source for "what can this account do" (governance-22): the server's effective read, shared with My access and the
// refused state (reference/authz).
export type { AccessEffective, AccessEffectiveEntry } from "../../reference/authz/api";
export type Account = components["schemas"]["UserSummary"];

// the access paths go through the shared client untyped until they are generated (see the header).
type Init = { params?: { query?: Record<string, string | number | boolean> }; headers?: Record<string, string>; body?: unknown };
const call = <T,>(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, init: Init = {}) =>
  unwrap((api[method] as unknown as (p: string, i: Init) => Promise<{ data?: T; error?: unknown; response: Response }>)(path, init));
// The key is the path with its query string, so each filter is its own entry and every access write invalidates it.
// Re-read on every visit: go-live (another slice's command) flips PREPARED grants to ENFORCED with no access write.
const q = <T,>(path: string, query?: Record<string, string>) => ({
  ...read(query ? `${path}?${new URLSearchParams(query)}` : path, () => call<T>("GET", path, { params: { query } })),
  refetchOnMount: "always" as const,
});
/** A list the server sends as a bare array, held as `{ items }` like every other list the screens read. */
const list = <T,>(path: string, query?: Record<string, string>) => {
  const r = q<T[]>(path, query);
  return { ...r, queryFn: async () => ({ items: await r.queryFn() }) };
};

const BASE = "/api/v1/access";
/** Every read an access write can change: the access reads and the go-live preview. */
export const ACCESS_READS = [BASE, "/api/v1/onboarding"] as unknown as PathPrefix[];

export const catalogQuery = q<AccessCatalog>(`${BASE}/catalog`);
export const meQuery = myAccessQuery;
export const opsQuery = q<{ account_id: Uuid; display_name: string }>(`${BASE}/ops`);
export const rolesQuery = list<AccessRole>(`${BASE}/roles`, { status: "ACTIVE" });
export const roleQuery = (id: string) => q<AccessRole>(`${BASE}/roles/${id}`);
/** Live grants (not ended or revoked), for one account or one role when asked. */
export const grantsQuery = (by?: { account_id: string } | { role_id: string }) => list<AccessGrant>(`${BASE}/grants`, by);
export const effectiveQuery = accountAccessQuery;
// one page of 200 accounts (the server's cap); the pilot signs in ops and HR workers only. Page it past that.
// Re-read on every visit, so an account invited a moment ago is grantable at once (governance-20).
export const accountsQuery = { ...get("/api/v1/users", { params: { query: { limit: 200 } } }), refetchOnMount: "always" as const };
export const reasonCodesQuery = get("/api/v1/reason-codes", { params: { query: { domain: "role_change" } } });

export const createRole = (body: RoleInput) => call<AccessRole>("POST", `${BASE}/roles`, { body: { ...body, status: "ACTIVE" } });
export type RoleReason = { reason_code: string; reason_note: string | null };
/**
 * Edits a role. `lines` go only when they changed (`linesChanged`): on a held role that is high-risk, so the reason and
 * the editor's passkey go with them; a rename alone needs neither.
 */
export const updateRole = async (r: AccessRole, body: RoleInput, linesChanged: boolean, reason?: RoleReason) => {
  const { lines, ...rest } = body;
  return call<AccessRole>("PATCH", `${BASE}/roles/${r.id}`, { body: { ...rest, expected_version: r.version, ...(linesChanged && { lines }), ...(reason && { ...reason, step_up: await assertPasskey() }) } });
};
/** A never-used draft is deleted; an active role is retired (kept for the record), which the server refuses while grants live. */
export const removeRole = (r: AccessRole, reason: RoleReason) =>
  r.status === "DRAFT"
    ? call<void>("DELETE", `${BASE}/roles/${r.id}`, { params: { query: { expected_version: r.version } } })
    : call<AccessRole>("POST", `${BASE}/roles/${r.id}/status`, { body: { expected_version: r.version, status: "RETIRED", ...reason } });

export const previewGrants = (b: Batch) => call<AccessGrantPreview>("POST", `${BASE}/grants/preview`, { body: b });
export type ApplyGrantsOutcome = { items: AccessGrant[]; operation_id: string };
/** grant is high-risk (decision #26): the receipt is applied with the actor's passkey, all or nothing. */
export const applyGrants = async (receipt_id: string, key: string) => call<ApplyGrantsOutcome>("POST", `${BASE}/grants/apply`, { headers: { "Idempotency-Key": key }, body: { receipt_id, step_up: await assertPasskey() } });
