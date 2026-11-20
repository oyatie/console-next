// SPDX-License-Identifier: LicenseRef-Proprietary
import createClient from "openapi-fetch";
import { afterEach, expect, test, vi } from "vitest";
import { api, configure, meAccessLogApi, type Platform, type paths } from "./index";

const passkeys: Platform["passkeys"] = { get: async () => null, create: async () => null };
afterEach(() => vi.unstubAllGlobals());

test("meAccessLogApi(api) sends limit and cursor query params to /api/v1/me/access-log", async () => {
  configure({ baseUrl: "https://console.example", passkeys, refresh: { kind: "cookie" } });
  const seen: string[] = [];
  vi.stubGlobal("fetch", async (input: Request | string, init?: RequestInit) => {
    const request = new Request(input, init);
    seen.push(`${request.method} ${request.url}`);
    return new Response(JSON.stringify({ items: [], next_cursor: null }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

  const page = await meAccessLogApi(api).list({ limit: 10, cursor: "c1" });

  expect(page).toEqual({ items: [], next_cursor: null });
  expect(seen).toEqual(["GET https://console.example/api/v1/me/access-log?limit=10&cursor=c1"]);
});

test("meAccessLogApi also accepts an explicit Client<paths>", async () => {
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

  const page = await meAccessLogApi(client).list({ limit: 5 });

  expect(page).toEqual({ items: [], next_cursor: null });
  expect(seen).toEqual(["GET https://console.example/api/v1/me/access-log?limit=5"]);
});
