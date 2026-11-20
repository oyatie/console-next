// SPDX-License-Identifier: LicenseRef-Proprietary
import type { Client } from "openapi-fetch";
import type { components, paths } from "./schema";
import { unwrap } from "./client";

export type MyAccessLogEvent = components["schemas"]["MyAccessLogEvent"];
export type MyAccessLogPage = components["schemas"]["MyAccessLogPage"];

export const meAccessLogApi = (client: Client<paths>) => ({
  list: (query?: { cursor?: string; limit?: number }) =>
    unwrap(client.GET("/api/v1/me/access-log", { params: { query } })),
});
