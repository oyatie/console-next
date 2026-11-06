// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { apiOf, bearerOf, codeOf } from "./helpers/api";
import { openTenant } from "./helpers/tenant";
import { go } from "./flows";

test("access records serve the current tenant month and refuse malformed paging", async ({ browser }) => {
  const admin = await openTenant(browser, "accesslog", "접속기록 조회");
  const bearer = bearerOf(admin);
  await go(admin, "/");
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
