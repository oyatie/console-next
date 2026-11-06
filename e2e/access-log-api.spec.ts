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

test("access-log filters use live choices, persist after reload and reset an empty intersection", async ({ browser }) => {
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
  await go(admin, "/audit/access-log?view=all");
  await expect(admin.getByRole("grid")).toBeVisible();
  await admin.getByRole("button", { name: "필터 선택", exact: true }).click();
  await admin.getByRole("combobox", { name: "접속자", exact: true }).selectOption(record.actor_id);
  await admin.getByRole("combobox", { name: "동작", exact: true }).selectOption({ label: "계정 목록 조회" });
  await admin.getByRole("combobox", { name: "대상 종류", exact: true }).selectOption({ label: "계정" });
  const day = before.period.from;
  await admin.getByLabel("시작일", { exact: true }).fill(day);
  const end = new Date(before.period.to);
  end.setUTCDate(end.getUTCDate() - 1);
  const last = end.toISOString().slice(0, 10);
  await admin.getByLabel("종료일", { exact: true }).fill(last);
  const response = admin.waitForResponse(r => new URL(r.url()).pathname === "/api/v1/access/access-log" && new URL(r.url()).searchParams.get("action") === "account.list_read");
  await admin.getByRole("button", { name: "필터 적용", exact: true }).click();
  const filtered = await (await response).json();
  expect(filtered.totals.events).toBeGreaterThan(0);
  expect(filtered.items.every((row: { actor_id: string; action: string; target_type: string }) => row.actor_id === record.actor_id && row.action === "account.list_read" && row.target_type === "user")).toBe(true);
  expect(new URL(admin.url()).searchParams.get("from")).toBe(day);
  expect(new URL(admin.url()).searchParams.get("to")).toBe(last);
  await admin.reload();
  await admin.getByRole("button", { name: "필터 선택", exact: true }).click();
  await expect(admin.getByRole("combobox", { name: "동작", exact: true })).toHaveValue("account.list_read");
  await admin.getByRole("combobox", { name: "대상 종류", exact: true }).selectOption({ label: "접속기록" });
  await admin.getByRole("button", { name: "필터 적용", exact: true }).click();
  await expect(admin.getByRole("heading", { name: "검색 결과가 없습니다" })).toBeVisible();
  await admin.getByRole("button", { name: "검색 초기화", exact: true }).click();
  await expect(admin.getByRole("grid")).toBeVisible();
  expect(new URL(admin.url()).searchParams.has("action")).toBe(false);
  expect(new URL(admin.url()).searchParams.has("actor")).toBe(false);
});
