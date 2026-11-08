// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { apiOf, bearerOf, codeOf } from "./helpers/api";
import { openTenant } from "./helpers/tenant";
import { go } from "./flows";

test("access records serve the current tenant month and refuse malformed paging", async ({ browser }) => {
  const admin = await openTenant(browser, "accesslog", "접속기록 조회");
  const bearer = bearerOf(admin);
  await go(admin, "/account");
  await expect.poll(bearer, { timeout: 15_000 }).not.toBe("");
  const api = apiOf(admin, bearer);
  expect((await admin.request.get("/api/v1/access/access-log")).status()).toBe(401);
  const current = await api("/access/access-log?limit=1");
  expect(current.status()).toBe(200);
  const page = await current.json() as { period: { from: string; to: string; time_zone: string; closed: boolean }; totals: { events: number; flagged: number }; items: unknown[]; next_cursor: string | null };
  expect(page.period.time_zone).toBe("Asia/Seoul");
  expect(page.period.closed).toBe(false);
  expect(Date.parse(page.period.to)).toBeGreaterThan(Date.parse(page.period.from));
  expect(page.items.length).toBeLessThanOrEqual(1);
  expect(page.totals.events).toBeGreaterThanOrEqual(page.items.length);
  const empty = await api("/access/access-log?period=2020-01&flagged=true");
  expect(empty.status()).toBe(200);
  expect(await empty.json()).toMatchObject({ items: [], next_cursor: null, totals: { events: 0, flagged: 0 } });
  const noMatch = await api("/access/access-log?search=nonexistent-access-record");
  expect(noMatch.status()).toBe(200);
  expect(await noMatch.json()).toMatchObject({ items: [], next_cursor: null, totals: { events: 0, flagged: 0 } });
  const searched = await api("/access/access-log?search=access_log.review_read&limit=1");
  expect(searched.status()).toBe(200);
  const filtered = await searched.json() as { items: { action: string }[]; next_cursor: string; totals: { events: number } };
  expect(filtered.items.map(row => row.action)).toEqual(["access_log.review_read"]);
  expect(filtered.totals.events).toBeGreaterThanOrEqual(2);
  expect(filtered.next_cursor).toBeTruthy();
  for (const search of ["", "&search=employee"]) {
    const refused = await api(`/access/access-log?cursor=${encodeURIComponent(filtered.next_cursor)}${search}`);
    expect(refused.status()).toBe(422);
    expect(await codeOf(refused)).toBe("cursor_invalid");
  }
  const next = await api(`/access/access-log?search=access_log.review_read&limit=1&cursor=${encodeURIComponent(filtered.next_cursor)}`);
  expect(next.status()).toBe(200);
  expect(await next.json()).toMatchObject({ totals: filtered.totals, items: [{ action: "access_log.review_read" }] });
  for (const term of ["actor\0name", "\t", "a\u007fb", "가".repeat(201), " ".repeat(201)]) {
    const response = await api(`/access/access-log?search=${encodeURIComponent(term)}`);
    expect(response.status()).toBe(400);
    expect(await codeOf(response)).toBe("search_invalid");
  }
  for (const [query, code] of [
    ["period=2026-13", "period_invalid"],
    ["limit=201", "limit_out_of_range"],
    ["cursor=invalid", "cursor_invalid"],
  ]) {
    const response = await api(`/access/access-log?${query}`);
    expect(response.status()).toBe(422);
    expect(await codeOf(response)).toBe(code);
  }
});

test("access-log filters intersect live choices, bind cursors and preserve empty-result choices", async ({ browser }) => {
  const admin = await openTenant(browser, "accessfilters", "접속기록 필터");
  const bearer = bearerOf(admin);
  await go(admin, "/account");
  await expect.poll(bearer, { timeout: 15_000 }).not.toBe("");
  const api = apiOf(admin, bearer);
  expect((await api("/users?limit=1")).status()).toBe(200);
  expect((await api("/access/access-log")).status()).toBe(200);
  const before = await (await api("/access/access-log")).json();
  const record = before.items.find((row: { action: string }) => row.action === "account.list_read");
  expect(record).toBeTruthy();
  expect(before.filter_options.actions).toContainEqual({ id: "account.list_read", label_key: "accessLog.action.account.list_read" });
  const rows = before.items as { actor_id: string; action: string; target_type: string }[];
  expect(before.filter_options.actions.map((choice: { id: string }) => choice.id).sort()).toEqual([...new Set(rows.map(row => row.action))].sort());
  expect(before.filter_options.target_types.map((choice: { id: string }) => choice.id).sort()).toEqual([...new Set(rows.map(row => row.target_type))].sort());
  expect(before.filter_options.actors.map((choice: { id: string }) => choice.id).sort()).toEqual([...new Set(rows.map(row => row.actor_id))].sort());
  expect((await api("/users?limit=1")).status()).toBe(200);
  const end = new Date(before.period.to);
  end.setUTCDate(end.getUTCDate() - 1);
  const query = new URLSearchParams({
    actor: record.actor_id, action: record.action, target_type: record.target_type,
    from: before.period.from, to: end.toISOString().slice(0, 10), limit: "1",
  });
  const response = await api(`/access/access-log?${query}`);
  expect(response.status()).toBe(200);
  const filtered = await response.json();
  expect(filtered.totals.events).toBe(2);
  expect(filtered.items).toHaveLength(1);
  expect(filtered.items[0]).toMatchObject({ actor_id: record.actor_id, action: record.action, target_type: record.target_type });
  expect(filtered.filter_options).toEqual(before.filter_options);
  expect(filtered.next_cursor).toEqual(expect.any(String));
  for (const key of ["actor", "action", "target_type", "from", "to"]) {
    const changed = new URLSearchParams(query);
    changed.delete(key);
    changed.set("cursor", filtered.next_cursor);
    const refused = await api(`/access/access-log?${changed}`);
    expect(refused.status()).toBe(422);
    expect(await codeOf(refused)).toBe("cursor_invalid");
  }
  query.set("cursor", filtered.next_cursor);
  const next = await api(`/access/access-log?${query}`);
  expect(next.status()).toBe(200);
  expect(await next.json()).toMatchObject({ totals: filtered.totals, filter_options: filtered.filter_options, next_cursor: null });
  query.delete("cursor");
  query.set("target_type", "access_log");
  const empty = await api(`/access/access-log?${query}`);
  expect(empty.status()).toBe(200);
  expect(await empty.json()).toMatchObject({ items: [], next_cursor: null, totals: { events: 0, flagged: 0 }, filter_options: before.filter_options });
});
