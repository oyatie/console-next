// SPDX-License-Identifier: LicenseRef-Proprietary
import type { Client } from "openapi-fetch";
import type { components, paths } from "./schema";
import { unwrap } from "./client";

type PeopleDataHealthPaths = Pick<
  paths,
  "/api/v1/hr/people/data-health" | "/api/v1/employees/import/{run_id}/rows/{source_key}/identifier"
>;

export const peopleDataHealthApi = (client: Client<PeopleDataHealthPaths>) => ({
  getPeopleDataHealth: (query?: { category?: string; limit?: number }) =>
    unwrap(client.GET("/api/v1/hr/people/data-health", { params: { query } })),
  recordImportRowIdentifier: (
    runId: string,
    sourceKey: string,
    body: components["schemas"]["ImportRowIdentifierRequest"],
  ) =>
    unwrap(
      client.PUT("/api/v1/employees/import/{run_id}/rows/{source_key}/identifier", {
        params: { path: { run_id: runId, source_key: sourceKey } },
        body,
      }),
    ),
});
