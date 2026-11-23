// SPDX-License-Identifier: LicenseRef-Proprietary
import createClient from "openapi-fetch";
import { expect, test } from "vitest";
import { leaveSelfServiceApi, type paths } from "./index";

test("leaveSelfServiceApi calls team-overlap and approval-preview endpoints", async () => {
  const seen: string[] = [];
  const client = createClient<paths>({
    baseUrl: "https://console.example",
    fetch: async (input) => {
      const request = input instanceof Request ? input : new Request(input);
      seen.push(`${request.method} ${request.url}`);
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  const apiClient = leaveSelfServiceApi(client);
  await apiClient.getTeamOverlap({ start_date: "2026-05-04", end_date: "2026-05-06" });
  await apiClient.getApprovalPreview();

  expect(seen).toEqual([
    "GET https://console.example/api/v2/me/leave/team-overlap?start_date=2026-05-04&end_date=2026-05-06",
    "GET https://console.example/api/v2/me/leave/approval-preview",
  ]);
});
