// SPDX-License-Identifier: LicenseRef-Proprietary
import { api, unwrap, type components } from "@console/api";
import { isMessageId, t } from "@console/i18n";
import { read, type PathPrefix } from "../../lib/query";

export type SupportSession = components["schemas"]["SupportSession"];
export type Sessions = components["schemas"]["SupportSessions"];
export type SupportDecision = components["schemas"]["SupportTenantDecision"];
const BASE = "/api/v1/support-sessions";
export const supportSessionsQuery = read(BASE, () => unwrap(api.GET(BASE)));
export const activeSupportQuery = read("/api/v1/support-sessions/active", () => unwrap(api.GET("/api/v1/support-sessions/active")));
/** G2 inbox source: the server's tenant approval permission owns visibility. */
export const pendingApprovalQuery = {
  ...supportSessionsQuery,
  select: (data: Sessions) => data.can_approve ? data.sessions.filter((s) => s.state === "OPERATOR_APPROVED" && !s.tenant_approved_at) : [],
};
export const SUPPORT_READS = [BASE] satisfies PathPrefix[];
export const decideSupportSession = (id: string, body: SupportDecision, key: string) =>
  unwrap(api.POST("/api/v1/support-sessions/{id}/decision", {params:{path:{id}},body,headers:{"Idempotency-Key":key}}));
export const endSupportSession = (id: string, key: string) =>
  unwrap(api.POST("/api/v1/support-sessions/{id}/end", {params:{path:{id}},headers:{"Idempotency-Key":key}}));
const REFUSALS = new Set([
  "step_up_required", "requester_cannot_approve", "no_second_operator", "not_tenant_approved", "request_expired",
  "session_ended", "session_expired", "read_only", "out_of_scope", "reveal_not_granted", "no_tenant_approver",
].map((code) => `support.refuse.${code}`));
export const supportRefusal = (code: string) => code === "unauthorized" ? t("supportAccess.wrongRealm") : REFUSALS.has(code) && isMessageId(code) ? t(code) : undefined;

export { ApiError } from "@console/api";
