// SPDX-License-Identifier: LicenseRef-Proprietary
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { configure } from "@console/api";
import { readIdentity } from "../../lib/query";
import { accessLogPages } from "./api";

beforeAll(() => configure({ baseUrl: "https://console.example", refresh: { kind: "cookie" }, passkeys: { get: async () => null, create: async () => null } }));
afterEach(() => vi.unstubAllGlobals());

test("access-log search partitions the cache and follows every cursor without changing the review scope", async () => {
  const requests: URL[] = [];
  vi.stubGlobal("fetch", async (request: Request) => {
    requests.push(new URL(request.url));
    return new Response(JSON.stringify({ items: [], next_cursor: "next" }), { headers: { "content-type": "application/json" } });
  });
  const query = accessLogPages("2026-10", true, "김민수");
  expect(readIdentity(query)).not.toEqual(readIdentity(accessLogPages("2026-10", true)));
  expect(readIdentity(query)).not.toEqual(readIdentity(accessLogPages("2026-10", true, "203.0.113.10")));
  await query.queryFn({ pageParam: undefined });
  await query.queryFn({ pageParam: "next" });
  expect(requests.map(url => Object.fromEntries(url.searchParams))).toEqual([
    { period: "2026-10", flagged: "true", search: "김민수", limit: "200" },
    { period: "2026-10", flagged: "true", search: "김민수", cursor: "next", limit: "200" },
  ]);
  await accessLogPages(undefined, false).queryFn({ pageParam: undefined });
  expect(requests[2]!.searchParams.has("search")).toBe(false);
  await accessLogPages("2026-10", true, "203.0.113.10").queryFn({ pageParam: undefined });
  expect(requests[3]!.searchParams.get("search")).toBe("203.0.113.10");
});
