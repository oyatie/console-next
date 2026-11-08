// SPDX-License-Identifier: LicenseRef-Proprietary
import { api, unwrap, type components, type paths } from "@console/api";
import { cursorRead } from "../../lib/query";

export type AccessLogFilters = Pick<Query, "actor" | "action" | "target_type" | "from" | "to">;
export type AccessLogFilterOptions = components["schemas"]["AccessLogPage"]["filter_options"];

export type AccessLogEvent = components["schemas"]["AccessLogEvent"];
export type AccessLogFlag = AccessLogEvent["flags"][number];

const path = "/api/v1/access/access-log";
type Query = NonNullable<paths[typeof path]["get"]["parameters"]["query"]>;
// Require advertised filter support so older servers cannot silently return unfiltered rows.
const page = async (query: Query) => {
  const result = await unwrap(api.GET(path, { params: { query } }));
  if ((query.actor || query.action || query.target_type || query.from || query.to) && !result.filter_options) {
    throw new Error("Structured access-log filters are unavailable");
  }
  return result;
};

export const accessLogPages = (period: string | undefined, flagged: boolean, search?: string, filters: AccessLogFilters = {}) =>
  cursorRead(path, { period, flagged, search, ...filters }, cursor => page({ period, flagged, search, ...filters, cursor, limit: 200 }));
