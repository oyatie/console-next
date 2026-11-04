// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import type { components } from "@console/api";
import { expectAxe, fits } from "../a11y";
import { attendanceDayBoard, attendancePerson } from "../mock/attendance-board";
import { id } from "../mock/fixtures";
import { mockRoute } from "../mock/route";
import { mockScreen } from "../mock/screen";
import { attendanceBoardScreens, type AttendanceState } from "./attendance";
import { attendanceBoardState, attendanceSheetState } from "./attendance-helpers";

test.beforeAll(() => loadCatalog("ko"));

for (const screen of attendanceBoardScreens.filter(screen => screen.key === "attendance-month" || screen.key === "attendance-person")) for (const state of Object.keys(screen.states) as AttendanceState[]) for (const width of [1440, 390]) {
  test(`${screen.key}: ${state} at ${width}px @ui-state`, async ({ page }) => {
    await attendanceBoardState(page, screen, state, width);
  });
}

for (const state of ["populated", "empty", "failed", "refused", "loading"] as const) for (const width of [1440, 390]) {
  test(`undo sheet ${state} at ${width}px @ui-state`, async ({ page }) => {
    await attendanceSheetState(page, "undo", state, width);
  });
}

const monthScreen = attendanceBoardScreens.find(screen => screen.key === "attendance-month")!;
for (const [label, path] of [["tab=month", monthScreen.path], ["no-tab", "/attendance?month=2026-10"]] as const) for (const [width, colorScheme] of [[1440, "light"], [390, "dark"]] as const) test(`the month board (${label}) is the only vertical scroller and keeps 400 rows reachable at ${width}px ${colorScheme}`, async ({ page }, testInfo) => {
  await page.emulateMedia({ colorScheme });
  await page.setViewportSize({ width, height: 640 });
  const fixture = await mockScreen(page, monthScreen, "populated");
  const base = attendanceDayBoard.groups[0]!.rows[0]!;
  const count = 400;
  const rows: components["schemas"]["AttendanceGridRow"][] = Array.from({ length: count }, (_, i) => ({
    ...base, employee_id: id(900 + i), employee_number: `AT-${900 + i}`, name: `근태직원 ${i + 1}`, unit_name: i < count / 2 ? "생산팀" : "물류팀",
    totals: { recognised: 0, approved: 0, unrecognised: 0, not_worked: 0, blocking: 0, decision: 0 },
    cells: Array.from({ length: 31 }, (_, day) => ({ date: `2026-10-${String(day + 1).padStart(2, "0")}`, plan_kind: "WORK" as const, recognised: 0, unrecognised: 0, not_worked: 0, marks: [] })),
  }));
  await mockRoute(page, "get", "/api/v1/attendance/month", { status: 200, json: { month: "2026-10", people_total: count, rows } });
  await page.goto(path);

  const grid = page.getByRole("grid", { name: t("attendanceRecords.grid.label"), exact: true });
  await expect(grid).toBeVisible();
  await expect(grid.getByText("근태직원 1", { exact: true })).toBeVisible();
  await expect(grid.getByText("0:00", { exact: true })).toHaveCount(0);
  const scroller = grid.locator("..");
  const scroll = await scroller.evaluate(el => ({ client: el.clientHeight, scroll: el.scrollHeight }));
  const main = await page.locator("#main").evaluate(el => ({ client: el.clientHeight, scroll: el.scrollHeight }));
  expect(scroll.scroll).toBeGreaterThan(scroll.client);
  expect(main.scroll).toBeLessThanOrEqual(main.client + 1);
  const sticky = await scroller.evaluate(el => {
    const head = el.querySelector<HTMLElement>("thead th")!;
    el.scrollTop = 160;
    return { position: getComputedStyle(head).position, head: head.getBoundingClientRect().top, box: el.getBoundingClientRect().top };
  });
  expect(sticky.position).toBe("sticky");
  expect(Math.abs(sticky.head - sticky.box)).toBeLessThanOrEqual(1);
  await scroller.evaluate(el => { el.scrollTop = el.scrollHeight; });
  const last = grid.getByText(`근태직원 ${count}`, { exact: true });
  await expect(last).toBeVisible();
  await expect(last).toBeInViewport();
  await fits(page, `month-board/${label}/${width}/${colorScheme}`);
  await expectAxe(page, `month-board/${label}/${width}/${colorScheme}`);
  await testInfo.attach("month-board", { body: await page.screenshot(), contentType: "image/png" });
  expect(fixture.unexpected).toEqual([]);
});

const personScreen = attendanceBoardScreens.find(screen => screen.key === "attendance-person")!;
test("the person card bottom is reachable at 390px", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.setViewportSize({ width: 390, height: 640 });
  const fixture = await mockScreen(page, personScreen, "populated");
  await page.goto(personScreen.path);

  const main = page.locator("#main");
  const bottom = page.getByText(t("attendanceRecords.day.noHistory"), { exact: true });
  await expect(bottom).toBeVisible();
  await main.evaluate(el => { el.scrollTop = el.scrollHeight; });
  await expect(bottom).toBeInViewport();
  await fits(page, "person-card/390/dark");
  await expectAxe(page, "person-card/390/dark");
  expect(fixture.unexpected).toEqual([]);
});

for (const height of [900, 640]) test(`the month dock keeps its actions anchored while the day read loads at 1440x${height}`, async ({ page }) => {
  await page.setViewportSize({ width: 1440, height });
  const fixture = await mockScreen(page, monthScreen, "populated");
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await mockRoute(page, "get", "/api/v1/attendance/people/{employee_id}/month", async () => {
    await held;
    return { status: 200, json: attendancePerson };
  });
  await page.goto(monthScreen.path);
  await page.getByRole("gridcell", { name: /^근태직원 1 2026-10-04/ }).click();
  await page.keyboard.press("p");
  const dock = page.getByRole("complementary");
  const close = dock.getByRole("button", { name: t("attendance.close"), exact: true }).last();
  await expect(close).toBeVisible();
  await expect(close).toBeInViewport();
  const before = await close.boundingBox();
  release();
  await expect(dock.getByRole("tablist", { name: t("attendanceRecords.day.tabs"), exact: true })).toBeVisible();
  expect(await close.boundingBox()).toEqual(before);
  await expect(close).toBeInViewport();
  expect(fixture.unexpected).toEqual([]);
});
