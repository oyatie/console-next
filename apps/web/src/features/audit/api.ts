// SPDX-License-Identifier: LicenseRef-Proprietary
import { api, ApiError, unwrap, type paths } from "@console/api";
import { STALE_TIME_MS } from "../../lib/freshness";
import { get, read } from "../../lib/query";

export { ApiError };

type AuditLogQuery = NonNullable<paths["/api/audit"]["get"]["parameters"]["query"]>;
type AuditLogResponse = paths["/api/audit"]["get"]["responses"][200]["content"]["application/json"];
export type AuditRecord = AuditLogResponse["items"][number];
type _AuditAttestation = paths["/api/v1/audit/attestation"]["get"]["responses"][200]["content"]["application/json"];

export const auditLogQuery = (params: AuditLogQuery) => ({
  ...get("/api/audit", { params: { query: params } }),
  staleTime: STALE_TIME_MS,
});

export const auditAttestationQuery = {
  ...read("/api/v1/audit/attestation", async () => {
    try {
      return await unwrap(api.GET("/api/v1/audit/attestation", {}));
    } catch (error) {
      if (error instanceof ApiError && error.status === 403) return null;
      throw error;
    }
  }),
  staleTime: STALE_TIME_MS,
  retry: false as const,
};
