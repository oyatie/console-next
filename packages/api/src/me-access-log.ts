// SPDX-License-Identifier: LicenseRef-Proprietary
import type { Client } from "openapi-fetch";
import type { paths } from "./schema";
import { unwrap } from "./client";

export const meAccessLogApi = (client: Client<Pick<paths, "/api/v1/me/access-log">>) => ({
  list: (query?: { cursor?: string; limit?: number }) =>
    unwrap(client.GET("/api/v1/me/access-log", { params: { query } })),
});
