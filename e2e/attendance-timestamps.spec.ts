// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import type { components } from "@console/api";
import { firstSignIn, go, kstDate, takeCode, tenantOnboardSubmit, tenantSlugField, unique, vendorPage } from "./flows";
import { apiOf, bearerOf } from "./helpers/api";
import { setupCompany } from "./setup-flows";
import { responseTimestampProblems, timestampContract } from "../scripts/check-timestamp-display.mjs";

test("attendance close timestamps are browser-readable and identical on write and read", { tag: ["@hr", "@regression"] }, async ({ browser }) => {
  test.setTimeout(300_000);
  const vendor = await vendorPage(browser);
  await go(vendor, "/platform");
  await vendor.getByRole("button", { name: "고객 계정 개설" }).click();
  await vendor.getByLabel("고객 이름").fill("근태시간검증");
  await tenantSlugField(vendor).fill(unique("timestamps"));
  await tenantOnboardSubmit(vendor).click();
  const admin = await firstSignIn(browser, await takeCode(vendor));
  const bearer = bearerOf(admin);
  const api = apiOf(admin, bearer);
  await setupCompany(admin, "근태시간검증", "본사");
  for (const path of ["/hr/readiness-summary", "/hr/attendance-import/summary", "/hr/attendance-records/me"]) {
    const response = await api(path);
    expect(response.status(), await response.text()).toBe(200);
    expect(responseTimestampProblems(timestampContract, `/api/v1${path}`, "get", response.status(), await response.json())).toEqual([]);
  }
  const audit = await admin.request.get("/api/audit?limit=10", { headers: { authorization: bearer() } });
  expect(audit.status(), await audit.text()).toBe(200);
  const events = await audit.json();
  expect(events.items.length).toBeGreaterThan(0);
  expect(responseTimestampProblems(timestampContract, "/api/audit", "get", audit.status(), events)).toEqual([]);
  expect(await admin.evaluate((items: { occurred_at: string }[]) => items.every(item => Number.isFinite(Date.parse(item.occurred_at))), events.items)).toBe(true);
  const month = kstDate(-60).slice(0, 7);

  const close = await api("/attendance/closes", "POST", { month, attest: true });
  expect(close.status(), await close.text()).toBe(201);
  const snapshot = await close.json() as components["schemas"]["AttendanceMonthClose"];
  const amendment = await api(`/attendance/closes/${snapshot.id}/amendments`, "POST", {
    reason: "근거 보완", detail: "마감 후 출근부 근거 보완",
  }, { "Idempotency-Key": crypto.randomUUID() });
  expect(amendment.status(), await amendment.text()).toBe(200);
  const correction = await amendment.json() as components["schemas"]["AttendanceCloseAmendment"];

  const timestamps = [snapshot.attested_at, snapshot.closed_at, correction.created_at];
  for (const value of timestamps) expect(value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/);
  expect(await admin.evaluate((values: string[]) => values.every(value => Number.isFinite(Date.parse(value))), timestamps)).toBe(true);
  const response = await api(`/attendance/closes?month=${month}`);
  expect(response.status(), await response.text()).toBe(200);
  const board = await response.json() as components["schemas"]["AttendanceCloseBoard"];
  expect(board.items.find(item => item.close?.id === snapshot.id)?.close).toEqual({ ...snapshot, amendments: [correction] });
});
