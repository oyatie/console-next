// SPDX-License-Identifier: LicenseRef-Proprietary
import type { Client } from "openapi-fetch";
import type { components, paths } from "./schema";
import { unwrap } from "./client";

/** Operator transport; consent and tenant history use the tenant API. */
export const supportSessionsApi = (client: Client<paths>) => ({
  list: (org_id: string) => unwrap(client.GET("/api/platform/support-sessions", { params: { query: { org_id } } })),
  request: (body: components["schemas"]["SupportRequest"]) => unwrap(client.POST("/api/platform/support-sessions", { body })),
  approve: (id: string, body: components["schemas"]["SupportOperatorDecision"]) => unwrap(client.POST("/api/platform/support-sessions/{id}/approve", { params: { path: { id } }, body })),
  start: (id: string, body: components["schemas"]["SupportOperatorDecision"]) => unwrap(client.POST("/api/platform/support-sessions/{id}/start", { params: { path: { id } }, body })),
  end: (id: string, org_id: string) => unwrap(client.POST("/api/platform/support-sessions/{id}/end", { params: { path: { id } }, body: { org_id } })),
});
