// SPDX-License-Identifier: LicenseRef-Proprietary
import createClient from "openapi-fetch";
import { expect, test } from "vitest";
import { meAccessLogApi, type paths } from "./index";

test("meAccessLogApi sends limit and cursor query params to /api/v1/me/access-log", async () => {
  const seen: string[] = [];
  const client = createClient<paths>({
    baseUrl: "https://console.example",
    fetch: async (input) => {
      const request = input instanceof Request ? input : new Request(input);
      seen.push(`${request.method} ${request.url}`);
      return new Response(JSON.stringify({ items: [], next_cursor: null }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  const page = await meAccessLogApi(client).list({ limit: 10, cursor: "c1" });

  expect(page).toEqual({ items: [], next_cursor: null });
  expect(seen).toEqual(["GET https://console.example/api/v1/me/access-log?limit=10&cursor=c1"]);
});
