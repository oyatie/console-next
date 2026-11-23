// SPDX-License-Identifier: LicenseRef-Proprietary
import {
  api,
  assertPasskey,
  unwrap,
  type components,
  type paths,
} from "@console/api";
import { STALE_TIME_MS } from "../../lib/freshness";
import { cursorRead, get } from "../../lib/query";
export { ApiError } from "@console/api";

export type AccessLogFilters = Pick<Query, "actor" | "action" | "target_type" | "from" | "to">;
export type AccessLogPage = components["schemas"]["AccessLogPage"];
export type AccessLogFilterOptions = AccessLogPage["filter_options"];

export type AccessLogEvent = components["schemas"]["AccessLogEvent"];
export type AccessLogFlag = AccessLogEvent["flags"][number];
export type AccessLogReview = components["schemas"]["AccessLogReview"];

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

export const accessLogPages = (period: string | undefined, flagged: boolean, search?: string, filters: AccessLogFilters = {}, limit = 200) =>
  cursorRead(path, { period, flagged, search, ...filters, limit }, cursor => page({ period, flagged, search, ...filters, cursor, limit }));

export const accessLogReviewQuery = (period: string) => ({
  ...get("/api/v1/access/access-log/reviews/{period}", { params: { path: { period } } }),
  staleTime: STALE_TIME_MS,
  retry: false as const,
});

export const startAccessLogReview = (period: string, idempotencyKey: string) =>
  unwrap(
    api.POST("/api/v1/access/access-log/reviews/{period}/start", {
      params: { path: { period }, header: { "Idempotency-Key": idempotencyKey } },
    }),
  );

export const recordAccessLogFinding = (
  period: string,
  idempotencyKey: string,
  body: {
    event_id?: string | null;
    disposition: "confirmed" | "action_required";
    outcome?: string | null;
    note?: string | null;
  },
) =>
  unwrap(
    api.POST("/api/v1/access/access-log/reviews/{period}/findings", {
      params: { path: { period }, header: { "Idempotency-Key": idempotencyKey } },
      body,
    }),
  );

export const completeAccessLogReview = async (period: string, idempotencyKey: string) => {
  const step_up = await assertPasskey();
  return unwrap(
    api.POST("/api/v1/access/access-log/reviews/{period}/complete", {
      params: { path: { period }, header: { "Idempotency-Key": idempotencyKey } },
      body: { step_up },
    }),
  );
};
