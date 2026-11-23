// SPDX-License-Identifier: LicenseRef-Proprietary
import type { Client } from "openapi-fetch";
import type { components, paths } from "./schema";
import { unwrap } from "./client";

export const platformGroupsApi = (client: Client<paths>) => ({
  list: () => unwrap(client.GET("/api/platform/groups")),
  create: (body: components["schemas"]["CreatePlatformGroupRequest"]) =>
    unwrap(client.POST("/api/platform/groups", { body })),
  update: (id: string, body: components["schemas"]["UpdatePlatformGroupRequest"]) =>
    unwrap(client.PATCH("/api/platform/groups/{id}", { params: { path: { id } }, body })),
  listAccounts: (id: string) =>
    unwrap(client.GET("/api/platform/groups/{id}/accounts", { params: { path: { id } } })),
  createAccount: (id: string, body: components["schemas"]["CreatePlatformGroupAccountRequest"]) =>
    unwrap(client.POST("/api/platform/groups/{id}/accounts", { params: { path: { id } }, body })),
  revokeRole: (
    id: string,
    userId: string,
    groupRole: components["schemas"]["PlatformGroupRole"],
  ) =>
    unwrap(
      client.DELETE("/api/platform/groups/{id}/accounts/{user_id}/roles/{group_role}", {
        params: { path: { id, user_id: userId, group_role: groupRole } },
      }),
    ),
  assignOrg: (id: string, orgId: string, body: components["schemas"]["StepUpRequest"]) =>
    unwrap(
      client.PUT("/api/platform/groups/{id}/organizations/{org_id}", {
        params: { path: { id, org_id: orgId } },
        body,
      }),
    ),
  removeOrg: (id: string, orgId: string) =>
    unwrap(
      client.DELETE("/api/platform/groups/{id}/organizations/{org_id}", {
        params: { path: { id, org_id: orgId } },
      }),
    ),
});
