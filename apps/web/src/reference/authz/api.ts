export { ApiError } from "@console/api";
import { api, session, unwrap, type components } from "@console/api";
import { get } from "../../lib/query";

type Capability = components["schemas"]["MeAuthzCapability"];
export type Feature =
  | "legal_entity_manage"
  | "org_change_read"
  | "org_change_draft"
  | "org_change_approve"
  | "org_change_apply"
  | "employee_directory_read"
  | "employee_directory_manage"
  | "user_manage"
  | "period_lock_manage"
  | "exit_case_report"
  | "exit_case_hr_confirm"
  | "exit_case_hq_confirm"
  | "exit_settlement_manage"
  | "excel_download"
  | "attendance_exception_manage"
  // BW-13: Cedar-only; listed once the projection carries it.
  | "job_title_manage";

/** Any step of the exit workflow: who the exit list and its cases are for. */
export const EXIT_FEATURES = ["exit_case_report", "exit_case_hr_confirm", "exit_case_hq_confirm", "exit_settlement_manage"] as const satisfies readonly Feature[];

export const authzQuery = get("/api/v1/me/authz");

/**
 * Advisory grant check from /me/authz. `caps` undefined = still loading: not granted (no flash of
 * controls the caller lacks). `failed` = the projection is unavailable: granted, the server decides.
 * request_only is not a grant. `scope` "all" asks for a door that decides per person (AX-5): the
 * whole tenant (`org_wide`) or a entity · workplace · department grant (`scoped`), inside which the server admits
 * the holder. "tenant" asks for the whole tenant only: doors that act on every entity at once (roster
 * import, number rules, period locks) refuse a scoped holder with `scope_tenant_wide_only`. "branch" asks for a
 * full grant over at least the holder's branches (BW-22).
 */
export const granted = (caps: readonly Capability[] | undefined, failed = false) => (f: Feature, scope?: "all" | "tenant" | "branch") =>
  failed ||
  !!caps?.some(
    (c) =>
      c.feature === f &&
      c.permission !== "request_only" &&
      (scope !== "all" || c.org_wide || c.scoped) &&
      (scope !== "tenant" || c.org_wide) &&
      (scope !== "branch" || c.permission === "allow"),
  );

/** Platform tokens are refused by /me/authz; the vendor menu is fixed. */
export const authzApplies = () => !session.claims?.platform;

// What I may do, as the server decides it (governance-22): one effective read per account — Cedar over the grant set,
// each line with its caveats. My access, the person-access view and every refused screen read it.
export type AccessEffective = components["schemas"]["AccessEffective"];
export type AccessEffectiveEntry = components["schemas"]["AccessEffectiveEntry"];
export const myAccessQuery = { ...get("/api/v1/access/me"), refetchOnMount: "always" as const };
export const accountAccessQuery = (accountId: string) => ({
  ...get("/api/v1/access/accounts/{accountId}/effective", { params: { path: { accountId } } }),
  refetchOnMount: "always" as const,
});
/** Who can grant: the count and up to five names a refusal shows (worst-case-44). */
export const grantersQuery = get("/api/v1/access/granters");
export type AccessRequestReason = components["schemas"]["AccessRequestReason"];
export const ACCESS_REQUEST_REASONS = ["NEW_DUTY", "COVER", "NEEDED_NOW", "OTHER"] as const satisfies readonly AccessRequestReason[];
/** "request access" from a refused screen: a record the holders of access management see (one open per screen; again answers it). */
export const requestAccess = (body: { screen: string; reason_code: AccessRequestReason; note?: string | null }) =>
  unwrap(api.POST("/api/v1/access/requests", { body }));
/** The holder records that they were told of a grant (decisions D0.2): only then does it make them a second person. */
export const confirmGrantNotice = (grantId: string) =>
  unwrap(api.POST("/api/v1/access/grants/{grantId}/notice", { params: { path: { grantId } } }));
/** The open access requests for a holder of access management (otherwise the caller's own), newest first. */
export const accessRequestsQuery = { ...get("/api/v1/access/requests"), refetchOnMount: "always" as const };
export type AccessRequest = components["schemas"]["AccessRequest"];
/** Closes a request: DONE or DECLINED by a granter, WITHDRAWN by the requester. */
export const closeAccessRequest = (requestId: string, status: "DONE" | "DECLINED" | "WITHDRAWN") =>
  unwrap(api.POST("/api/v1/access/requests/{requestId}/close", { params: { path: { requestId } }, body: { status } }));
