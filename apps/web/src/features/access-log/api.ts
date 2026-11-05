// SPDX-License-Identifier: LicenseRef-Proprietary
import { api, unwrap, type components, type paths } from "@console/api";
import { cursorRead } from "../../lib/query";

export type AccessLogEvent = components["schemas"]["AccessLogEvent"];
export type AccessLogFlag = AccessLogEvent["flags"][number];

const path = "/api/v1/access/access-log";
const page = (query: paths[typeof path]["get"]["parameters"]["query"]) =>
  unwrap(api.GET(path, { params: { query } }));

export const accessLogPages = (period: string | undefined, flagged: boolean) =>
  cursorRead(path, { period, flagged }, cursor => page({ period, flagged, cursor, limit: 200 }));
