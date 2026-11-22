// Pilot roles: tenant role CRUD, dated grants per account with a scope (preview -> passkey -> apply), the
// per-account effective view and the ops holder, backed by generated OpenAPI contracts in @console/api.
export { ApiError } from "@console/api";
import { api, assertPasskey, unwrap, type components } from "@console/api";
import { get, offsetRead, type PathPrefix } from "../../lib/query";
import { accountAccessQuery, myAccessQuery } from "../../reference/authz/api";
import type { Level } from "./domain/grid";
import type { KindRule, Scope } from "./domain/scope";

type Uuid = string;
type Ts = string;
const MAX_DIRECTORY_PAGE_LIMIT = 200;
export type Enforcement = components["schemas"]["AccessEnforcement"];
/**
 * An effective row adds SCOPE_UNAVAILABLE (an enforced grant whose scope no longer resolves, a voided workplace) and
 * ACCOUNT_INACTIVE (a deactivated account uses nothing).
 */
export type EffectiveState = components["schemas"]["AccessEffectiveEntry"]["enforcement"];
export type AccessCatalogDomain = { domain: string; grantable: boolean; levels: Level[]; operations: { operation: string; level: Level }[] };
export type AccessCatalog = { domains: AccessCatalogDomain[]; levels: Level[]; scope_kinds: KindRule[]; reason_domain: "role_change" };
export type AccessRoleLine = { domain: string; levels: Level[] };
export type AccessRole = { id: Uuid; name_ko: string; name_en?: string | null; description?: string | null; status: "DRAFT" | "ACTIVE" | "RETIRED"; version: number; lines: AccessRoleLine[]; holder_count: number };
export type RoleInput = { name_ko: string; description: string | null; lines: AccessRoleLine[] };
export type AccessScope = Scope & { readonly node_name?: string | null };
export type AccessGrant = components["schemas"]["AccessGrant"];
export type GrantOp =
  | { op: "grant"; account_id: Uuid; role_id: Uuid; scope: Scope; valid_from?: Ts; valid_to: Ts | null; effective_in_setup: boolean }
  | { op: "revoke"; grant_id: Uuid }
  | { op: "set_end"; grant_id: Uuid; valid_to: Ts | null };
export type Batch = { operations: GrantOp[]; reason_code: string; reason_note: string | null };
export type PreviewItem = components["schemas"]["AccessGrantPreviewItem"];
export type AccessGrantPreview = components["schemas"]["AccessGrantPreview"];
// One source for "what can this account do": the server's effective read, shared with My access and the
// refused state (reference/authz).
export type { AccessEffective, AccessEffectiveEntry } from "../../reference/authz/api";
export type Account = components["schemas"]["AccessPerson"];
export type OpsUsageEntry = components["schemas"]["OpsUsageEntry"];
type UserPage = components["schemas"]["UserPage"];

const BASE = "/api/v1/access";
/** Every read an access write can change: the access reads and the go-live preview. */
export const ACCESS_READS = [BASE, "/api/v1/onboarding"] as unknown as PathPrefix[];

export const catalogQuery = { ...get("/api/v1/access/catalog"), refetchOnMount: "always" as const };
export const meQuery = myAccessQuery;
export const opsQuery = { ...get("/api/v1/access/ops"), refetchOnMount: "always" as const };
export const opsUsageQuery = (limit = 100) => get("/api/v1/access/ops-usage", { params: { query: { limit } } });
export const rolesQuery = {
  ...get("/api/v1/access/roles", { params: { query: { status: "ACTIVE" } } }),
  queryFn: async () => ({ items: await unwrap(api.GET("/api/v1/access/roles", { params: { query: { status: "ACTIVE" } } })) }),
  refetchOnMount: "always" as const,
};
export const roleQuery = (id: string) => ({
  ...get("/api/v1/access/roles/{roleId}", { params: { path: { roleId: id } } }),
  refetchOnMount: "always" as const,
});
export const roleVersionsQuery = (roleId: string) => get("/api/v1/access/roles/{roleId}/versions", { params: { path: { roleId } } });
/** Live grants (not ended or revoked), for one account or one role when asked. */
export const grantsQuery = (by?: { account_id: string } | { role_id: string }) => {
  const query = by && ("account_id" in by ? { account_id: by.account_id } : { role_id: by.role_id });
  const descriptor = get("/api/v1/access/grants", query ? { params: { query } } : undefined);
  return {
    ...descriptor,
    queryFn: async () => ({ items: await descriptor.queryFn() }),
    refetchOnMount: "always" as const,
  };
};
export const effectiveQuery = accountAccessQuery;
export const accountQuery = (id: string) => get("/api/v1/access/people/{id}", { params: { path: { id } } });

const directoryQueryParams = (search: string, limit: number, offset: number) => {
  const trimmed = search.trim();
  return {
    ...(trimmed ? { search: trimmed } : {}),
    limit: Math.min(limit, MAX_DIRECTORY_PAGE_LIMIT),
    offset,
  };
};

// Re-read on every visit, so an account invited a moment ago is grantable at once.
export const accountSearchQuery = (search = "", limit = 50, offset = 0) => ({
  ...get("/api/v1/users", { params: { query: directoryQueryParams(search, limit, offset) } }),
  refetchOnMount: "always" as const,
});

export const accountPagesQuery = (search = "", limit = 100) => {
  const trimmed = search.trim();
  const pageLimit = Math.min(limit, MAX_DIRECTORY_PAGE_LIMIT);
  const query = { ...(trimmed ? { search: trimmed } : {}), limit: pageLimit };
  return {
    ...offsetRead<UserPage>(
      "/api/v1/users",
      query,
      (pageParam) => unwrap(api.GET("/api/v1/users", { params: { query: directoryQueryParams(trimmed, pageLimit, pageParam) } })),
    ),
    refetchOnMount: "always" as const,
  };
};

export const accountsQuery = { ...get("/api/v1/users", { params: { query: { limit: MAX_DIRECTORY_PAGE_LIMIT } } }), refetchOnMount: "always" as const };
export const reasonCodesQuery = get("/api/v1/reason-codes", { params: { query: { domain: "role_change" } } });

type RoleLineInput = components["schemas"]["AccessRoleLineInput"];

export const createRole = (body: RoleInput) =>
  unwrap(api.POST("/api/v1/access/roles", {
    body: { ...body, status: "ACTIVE", lines: body.lines as RoleLineInput[] },
  }));
export type RoleReason = { reason_code: string; reason_note: string | null };
/**
 * Edits a role. `lines` go only when they changed (`linesChanged`): on a held role that is high-risk, so the reason and
 * the editor's passkey go with them; a rename alone needs neither.
 */
export const updateRole = async (r: AccessRole, body: RoleInput, linesChanged: boolean, reason?: RoleReason) => {
  const { lines, ...rest } = body;
  return unwrap(api.PATCH("/api/v1/access/roles/{roleId}", {
    params: { path: { roleId: r.id } },
    body: {
      ...rest,
      expected_version: r.version,
      ...(linesChanged && { lines: lines as RoleLineInput[] }),
      ...(reason && { ...reason, step_up: await assertPasskey() }),
    },
  }));
};
/** A never-used draft is deleted; an active role is retired (kept for the record), which the server refuses while grants live. */
export const removeRole = (r: AccessRole, reason: RoleReason) =>
  r.status === "DRAFT"
    ? unwrap(api.DELETE("/api/v1/access/roles/{roleId}", { params: { path: { roleId: r.id }, query: { expected_version: r.version } } }))
    : unwrap(api.POST("/api/v1/access/roles/{roleId}/status", {
        params: { path: { roleId: r.id } },
        body: { expected_version: r.version, status: "RETIRED", ...reason },
      }));

export const previewGrants = (b: Batch) =>
  unwrap(api.POST("/api/v1/access/grants/preview", { body: b as components["schemas"]["AccessGrantBatchRequest"] }));
export type ApplyGrantsOutcome = components["schemas"]["ApplyGrantsOutcome"];
/** grant is high-risk: the receipt is applied with the actor's passkey, all or nothing. */
export const applyGrants = async (receipt_id: string, key: string) =>
  unwrap(api.POST("/api/v1/access/grants/apply", {
    params: { header: { "Idempotency-Key": key } },
    body: { receipt_id, step_up: await assertPasskey() },
  }));
