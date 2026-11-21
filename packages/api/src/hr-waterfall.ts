// SPDX-License-Identifier: LicenseRef-Proprietary
import type { Client } from "openapi-fetch";
import type { components, paths } from "./schema";
import { unwrap } from "./client";

type HrWaterfallPaths = Pick<
  paths,
  | "/api/v1/employees/register-facts/query"
  | "/api/v1/employees/{id}/unit-position"
  | "/api/v1/hr/exit-cases/bulk"
  | "/api/v1/hr/exit-cases/counts"
  | "/api/v1/change-requests/counts"
>;

export const hrWaterfallApi = (client: Client<HrWaterfallPaths>) => ({
  queryRegisterFacts: (body: components["schemas"]["RegisterFactsQueryRequest"]) =>
    unwrap(client.POST("/api/v1/employees/register-facts/query", { body })),
  getEmployeeUnitPosition: (id: string) =>
    unwrap(client.GET("/api/v1/employees/{id}/unit-position", { params: { path: { id } } })),
  bulkReportExitCases: (
    body: components["schemas"]["BulkReportExitCasesRequest"],
    idempotencyKey: string,
  ) =>
    unwrap(
      client.POST("/api/v1/hr/exit-cases/bulk", {
        body,
        params: { header: { "Idempotency-Key": idempotencyKey } },
      }),
    ),
  getExitCaseCounts: (query?: { search?: string }) =>
    unwrap(client.GET("/api/v1/hr/exit-cases/counts", { params: { query } })),
  getChangeRequestCounts: () => unwrap(client.GET("/api/v1/change-requests/counts")),
});
