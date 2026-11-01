// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { attendanceReads } from "../mock/attendance";
import { failure, id } from "../mock/fixtures";
import { mockRoute } from "../mock/route";
import { mockScreen } from "../mock/screen";
import { screens } from "./registry";
import { attendanceScreens, type AttendanceState } from "./attendance";
import { attendanceReadState } from "./attendance-helpers";

test.beforeAll(() => loadCatalog("ko"));
const screen = attendanceScreens.find(candidate => candidate.key === "attendance-issues")!;

for (const state of Object.keys(screen.states) as AttendanceState[]) for (const width of [1440, 390]) {
  test(`${screen.key}: ${state} at ${width}px @ui-state`, async ({ page }) => {
    await attendanceReadState(page, screen, state, width);
  });
}

test("an exception opens its day under the fixed Today label", async ({ page }) => {
  const fixture = { ...await mockScreen(page, screens[0], "populated"), ...await attendanceReads(page, screen, "populated") };
  await mockRoute(page, "get", "/api/v1/attendance/days", { status: 403, json: failure("forbidden") });
  await page.goto(screen.path);
  await page.getByRole("grid").getByText("검증직원 1", { exact: true }).click();
  await expect.poll(() => Object.fromEntries(new URL(page.url()).searchParams)).toMatchObject({ tab: "day", date: "2026-10-01", month: "2026-10", wp: id(4) });
  await expect(page.getByRole("navigation", { name: t("attendance.tabs") }).getByRole("link", { name: t("attendance.tab.day"), exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page.getByText(t("common.denied.title.plain"), { exact: true })).toBeVisible();
  expect(fixture.forbidden).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});
