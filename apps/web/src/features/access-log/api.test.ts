// SPDX-License-Identifier: LicenseRef-Proprietary
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { configure } from "@console/api";
import { readIdentity } from "../../lib/query";
import { accessLogPages } from "./api";

beforeAll(() => configure({ baseUrl: "https://console.example", refresh: { kind: "cookie" }, passkeys: { get: async () => null, create: async () => null } }));
afterEach(() => vi.unstubAllGlobals());

test("refused-filter recovery limits the audited read and has a separate cache entry", async () => {
  const requests: URL[] = [];
  vi.stubGlobal("fetch", async (request: Request) => {
    requests.push(new URL(request.url));
    return new Response(JSON.stringify({ items: [], next_cursor: null }), { headers: { "content-type": "application/json" } });
  });
  const recovery = accessLogPages("2026-10", false, undefined, {}, 1);
  expect(readIdentity(recovery)).not.toEqual(readIdentity(accessLogPages("2026-10", false)));
  await recovery.queryFn({ pageParam: undefined });
  expect(Object.fromEntries(requests[0]!.searchParams)).toEqual({ period: "2026-10", flagged: "false", limit: "1" });
});

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

test("structured access-log filters partition the cache and stay bound to every cursor", async () => {
  const requests: URL[] = [];
  vi.stubGlobal("fetch", async (request: Request) => {
    requests.push(new URL(request.url));
    return new Response(JSON.stringify({ items: [], next_cursor: "next", filter_options: { actors: [], actions: [], target_types: [] } }), { headers: { "content-type": "application/json" } });
  });
  const filters = { actor: "actor-id", action: "employee.export", target_type: "employee", from: "2026-10-05", to: "2026-10-20" };
  const query = accessLogPages("2026-10", true, undefined, filters);
  for (const key of Object.keys(filters) as (keyof typeof filters)[]) {
    expect(readIdentity(query)).not.toEqual(readIdentity(accessLogPages("2026-10", true, undefined, { ...filters, [key]: undefined })));
  }
  await query.queryFn({ pageParam: undefined });
  await query.queryFn({ pageParam: "next" });
  expect(requests.map(url => Object.fromEntries(url.searchParams))).toEqual([
    { ...filters, period: "2026-10", flagged: "true", limit: "200" },
    { ...filters, period: "2026-10", flagged: "true", limit: "200", cursor: "next" },
  ]);
});

test.each(["actor", "action", "target_type", "from", "to"])("an older server cannot present unfiltered records as %s-filter results", async key => {
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ items: [{ actor_name: "이하나" }], next_cursor: null }), { headers: { "content-type": "application/json" } }));
  await expect(accessLogPages("2026-10", true, undefined, { [key]: "selected" }).queryFn({ pageParam: undefined }))
    .rejects.toThrow("Structured access-log filters are unavailable");
});
