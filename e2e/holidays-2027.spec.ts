// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { kstDate } from "./flows";
import { openSchedule } from "./helpers/attendance";
import { apiOf, bearerOf } from "./helpers/api";
import { staffedTenant } from "./setup-flows";

test("2027 official holidays are loaded in the calendar API and public holiday screen", { tag: ["@hr", "@regression"] }, async ({ browser }) => {
  const { admin } = await staffedTenant(browser, "hol27", "공휴일검토상사");
  const bearer = bearerOf(admin);
  await openSchedule(admin);
  await expect.poll(bearer).not.toBe("");
  const api = apiOf(admin, bearer);
  const response = await api("/attendance/holidays?year=2027");
  expect(response.status()).toBe(200);
  const year = await response.json();
  expect(year).toMatchObject({ year: 2027, loaded: true, edition: "2027" });
  expect(year.public).toHaveLength(24);
  expect(year.public.find((h: { date: string }) => h.date === "2027-05-03"))
    .toMatchObject({ kind: "SUBSTITUTE", substitute_for: "2027-05-01", basis: expect.stringContaining("제3조 제1항 제1호") });
  await admin.getByRole("tab", { name: "공휴일 (읽기 전용)" }).click();
  // The screen opens the current year; use its own year stepper to select the edition.
  const card = admin.getByRole("region", { name: "공휴일 (읽기 전용)" });
  const current = Number(kstDate().slice(0, 4));
  for (let year = current; year !== 2027; year += year < 2027 ? 1 : -1) {
    await card.getByRole("button", { name: year < 2027 ? "다음 연도" : "이전 연도" }).click();
  }
  await expect(card.getByText("공휴일 기준 자료 · 2027년판")).toBeVisible();
  await expect(card.getByText("2027년 공휴일 기준 자료가 없습니다", { exact: true })).toHaveCount(0);
  const table = card.getByRole("table", { name: "공휴일 (읽기 전용)" });
  await expect(table.getByRole("row")).toHaveCount(25);
  const laborDay = table.getByRole("row").filter({ has: admin.getByRole("cell", { name: "노동절", exact: true }) });
  await expect(laborDay.getByRole("cell", { name: "노동절", exact: true })).toHaveCount(2);
  await expect(laborDay).not.toContainText("대체 없음");
  await expect(table.getByRole("row", { name: /노동절 대체공휴일/ })).toContainText("2027. 05. 01. (토)의 대체공휴일");
  await expect(table.getByRole("row", { name: /노동절 대체공휴일/ })).toContainText("제3조 제1항 제1호");
  await expect(table.getByRole("row", { name: /부처님 오신 날/ })).toContainText("2027. 05. 13.");
  const missing = await (await api("/attendance/holidays?year=2031")).json();
  expect(missing).toMatchObject({ loaded: false, public: [] });
});
