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
