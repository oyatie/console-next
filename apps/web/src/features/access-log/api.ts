// SPDX-License-Identifier: LicenseRef-Proprietary
import { api, unwrap, type components, type paths } from "@console/api";
import { cursorRead } from "../../lib/query";

export type AccessLogEvent = components["schemas"]["AccessLogEvent"];
export type AccessLogFlag = AccessLogEvent["flags"][number];

const path = "/api/v1/access/access-log";
type Query = NonNullable<paths[typeof path]["get"]["parameters"]["query"]>;
const page = (query: Query) =>
  unwrap(api.GET(path, { params: { query } }));

export const accessLogPages = (period: string | undefined, flagged: boolean, search?: string) =>
  cursorRead(path, { period, flagged, search }, cursor => page({ period, flagged, search, cursor, limit: 200 }));
