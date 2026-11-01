// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { attendanceDayBoard, attendancePerson } from "../mock/attendance-board";
import { screenAccess } from "../mock/fixtures";
import { mockRoute } from "../mock/route";
import { mockScreen } from "../mock/screen";
import { attendanceBoardScreens } from "./attendance";

test.beforeAll(() => loadCatalog("ko"));
const monthScreen = attendanceBoardScreens.find(screen => screen.key === "attendance-month")!;
const dayScreen = attendanceBoardScreens.find(screen => screen.key === "attendance-day")!;
test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-10-15T12:00:00+09:00"));
});

test("a first-time user opens attendance from the main menu", async ({ page }) => {
  const fixture = await mockScreen(page, monthScreen, "empty");
  await mockRoute(page, "get", "/api/v1/access/me", { status: 200, json: screenAccess("/attendance") });
  await page.goto("/");
  await page.getByRole("link", { name: "근태", exact: true }).click();
  await expect(page.getByRole("heading", { name: t("attendanceRecords.empty.title"), exact: true })).toBeVisible();
  await page.getByRole("link", { name: t("attendanceRecords.empty.toSchedule"), exact: true }).click();
  await page.getByRole("button", { name: t("attendancePatterns.types.add"), exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(fixture.unexpected).toEqual([]);
});

for (const today of ["2026-10-15", "2026-11-15"]) test(`closed month board and card show the served lock state with clock ${today}`, async ({ page }) => {
  await page.clock.setFixedTime(new Date(`${today}T12:00:00+09:00`));
  const fixture = await mockScreen(page, dayScreen, "populated");
  await mockRoute(page, "get", "/api/v1/attendance/days", { status: 200, json: { ...attendanceDayBoard, groups: attendanceDayBoard.groups.map(group => ({ ...group, rows: group.rows.map(row => ({ ...row, month_state: { state: "CLOSED" as const } })) })) } });
  const months: string[] = [];
  await mockRoute(page, "get", "/api/v1/attendance/people/{employee_id}/month", request => {
    months.push(new URL(request.url()).searchParams.get("month")!);
    return { status: 200, json: { ...attendancePerson, month_state: { state: "CLOSED" as const } } };
  });
  await page.goto(dayScreen.path);
  await expect(page.getByRole("link", { name: t("attendanceRecords.month.locks"), exact: true })).toBeVisible();
  await expect(page.getByRole("textbox")).toHaveCount(0);
  await page.getByRole("link", { name: "근태직원 1", exact: true }).click();
  await expect(page.getByText(t("attendanceRecords.card.closed", { month: "2026년 10월" }), { exact: true })).toBeVisible();
  expect(Object.fromEntries(new URL(page.url()).searchParams)).toMatchObject({ date: attendanceDayBoard.date, month: attendancePerson.month, person: attendancePerson.employee_id });
  expect(months).toEqual([attendancePerson.month]);
  expect(fixture.unexpected).toEqual([]);
});
