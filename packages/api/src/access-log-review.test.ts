// SPDX-License-Identifier: LicenseRef-Proprietary
import createClient from "openapi-fetch";
import { expect, test } from "vitest";
import { accessLogReviewApi, type paths } from "./index";

test("accessLogReviewApi calls all /api/v1/access/access-log/reviews/{period} endpoints", async () => {
  const seen: Array<{ method: string; url: string; key: string | null }> = [];
  const review = {
    id: "00000000-0000-0000-0000-000000000001",
    period: { from: "2026-09-01", to: "2026-09-30", time_zone: "Asia/Seoul" },
    scope: "tenant",
    reviewer: null,
    started_at: null,
    reviewed_at: null,
    due: "2026-10-15T14:59:59Z",
    overdue: false,
    flags_seen: null,
    findings: [],
    follow_up: { open: 0, total: 0 },
    state: "not_started",
  };
  const client = createClient<paths>({
    baseUrl: "https://console.example",
    fetch: async (input) => {
      const request = input instanceof Request ? input : new Request(input);
      seen.push({
        method: request.method,
        url: request.url,
        key: request.headers.get("idempotency-key"),
      });
      return new Response(JSON.stringify(review), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  const api = accessLogReviewApi(client);
  await expect(api.get("2026-09")).resolves.toMatchObject({ state: "not_started" });
  await expect(api.start("2026-09", "idem-start")).resolves.toMatchObject({ state: "not_started" });
  await expect(
    api.recordFinding("2026-09", "idem-finding", {
      event_id: "00000000-0000-0000-0000-000000000099",
      disposition: "confirmed",
      outcome: "justified",
    }),
  ).resolves.toMatchObject({ state: "not_started" });
  await expect(api.complete("2026-09", "idem-complete")).resolves.toMatchObject({ state: "not_started" });

  expect(seen).toEqual([
    { method: "GET", url: "https://console.example/api/v1/access/access-log/reviews/2026-09", key: null },
    { method: "POST", url: "https://console.example/api/v1/access/access-log/reviews/2026-09/start", key: "idem-start" },
    { method: "POST", url: "https://console.example/api/v1/access/access-log/reviews/2026-09/findings", key: "idem-finding" },
    { method: "POST", url: "https://console.example/api/v1/access/access-log/reviews/2026-09/complete", key: "idem-complete" },
  ]);
});
