// SPDX-License-Identifier: LicenseRef-Proprietary
import type { Client } from "openapi-fetch";
import type { paths } from "./schema";
import { unwrap } from "./client";

type LeaveSelfServicePaths = Pick<
  paths,
  "/api/v2/me/leave/team-overlap" | "/api/v2/me/leave/approval-preview"
>;

export const leaveSelfServiceApi = (client: Client<LeaveSelfServicePaths>) => ({
  getTeamOverlap: (query: { start_date: string; end_date: string }) =>
    unwrap(client.GET("/api/v2/me/leave/team-overlap", { params: { query } })),
  getApprovalPreview: () => unwrap(client.GET("/api/v2/me/leave/approval-preview")),
});
