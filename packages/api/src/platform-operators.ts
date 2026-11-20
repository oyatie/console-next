// SPDX-License-Identifier: LicenseRef-Proprietary
import type { Client } from "openapi-fetch";
import type { components, paths } from "./schema";
import { unwrap } from "./client";

export const platformOperatorsApi = (client: Client<paths>) => ({
  list: () => unwrap(client.GET("/api/platform/operators")),
  invite: (body: components["schemas"]["InvitePlatformOperatorRequest"]) =>
    unwrap(client.POST("/api/platform/operators", { body })),
  reissue: (id: string, body: components["schemas"]["ReissuePlatformOperatorInviteRequest"]) =>
    unwrap(client.POST("/api/platform/operators/{id}/reissue", { params: { path: { id } }, body })),
  revoke: (id: string, body: components["schemas"]["RevokePlatformOperatorRequest"]) =>
    unwrap(client.POST("/api/platform/operators/{id}/revoke", { params: { path: { id } }, body })),
});
