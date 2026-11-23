// SPDX-License-Identifier: LicenseRef-Proprietary
import type { Client } from "openapi-fetch";
import type { operations, paths } from "./schema";
import { unwrap } from "./client";

type AccessLogFindingRequest =
  operations["recordAccessLogFinding"]["requestBody"]["content"]["application/json"];
type AccessLogReviewCompleteRequest = NonNullable<
  operations["completeAccessLogReview"]["requestBody"]
>["content"]["application/json"];

export const accessLogReviewApi = (client: Client<paths>) => ({
  get: (period: string) =>
    unwrap(
      client.GET("/api/v1/access/access-log/reviews/{period}", {
        params: { path: { period } },
      }),
    ),
  start: (period: string, idempotencyKey: string) =>
    unwrap(
      client.POST("/api/v1/access/access-log/reviews/{period}/start", {
        params: { path: { period }, header: { "Idempotency-Key": idempotencyKey } },
      }),
    ),
  recordFinding: (period: string, idempotencyKey: string, body: AccessLogFindingRequest) =>
    unwrap(
      client.POST("/api/v1/access/access-log/reviews/{period}/findings", {
        params: { path: { period }, header: { "Idempotency-Key": idempotencyKey } },
        body,
      }),
    ),
  complete: (period: string, idempotencyKey: string, body?: AccessLogReviewCompleteRequest) =>
    unwrap(
      client.POST("/api/v1/access/access-log/reviews/{period}/complete", {
        params: { path: { period }, header: { "Idempotency-Key": idempotencyKey } },
        ...(body ? { body } : {}),
      }),
    ),
});
