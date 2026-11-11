// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { addDays, nextMonday } from "../../apps/web/src/ui/date/days";
import { shiftMonth } from "../../apps/web/src/features/attendance/domain/month";
import { dayText } from "../../apps/web/src/features/attendance/present";
import { todayKst } from "../../apps/web/src/lib/pure/today";
import { expectAxe, fits } from "../a11y";
import { attendanceReads } from "../mock/attendance";
import { mockRoute } from "../mock/route";
import { screenAccess } from "../mock/fixtures";
import { mockScreen } from "../mock/screen";
import { attendanceScreens, attendanceBoardScreens } from "./attendance";
import { screens } from "./registry";
import { openAttendance } from "../helpers/attendance";

const periodScreens = [...attendanceScreens, ...attendanceBoardScreens.filter(screen => screen.key !== "attendance-person")];
test.beforeAll(() => loadCatalog("ko"));

for (const screen of periodScreens) for (const theme of ["light", "dark"]) {
  test(`${screen.key} period navigation keeps scope in ${theme} @ui-state`, async ({ page }) => {
    await page.addInitScript(value => localStorage.setItem("console.theme", value), theme);
    const fixture = "tab" in screen
      ? { ...await mockScreen(page, screens[0], "populated"), ...await attendanceReads(page, screen, "populated") }
      : await mockScreen(page, screen, "populated");
    const week = screen.key === "attendance-overtime", day = screen.key === "attendance-day";
    const previous = page.getByRole("button", { name: t(week ? "attendance.week.prev" : day ? "attendanceRecords.toolbar.prevDay" : "attendanceRecords.toolbar.prevMonth"), exact: true });
    const next = page.getByRole("button", { name: t(week ? "attendance.week.next" : day ? "attendanceRecords.toolbar.nextDay" : "attendanceRecords.toolbar.nextMonth"), exact: true });
    const initial = new URL(screen.path, "http://localhost");
    const key = week || day ? "date" : "month", value = initial.searchParams.get(key)!;
    const period = page.getByRole("group", { name: "기간 이동", exact: true });
    const jump = period.getByRole("button", { name: week ? "이번 주" : day ? "오늘" : "이번 달", exact: true });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(screen.path);
    // Capture the built screen even when a regression assertion fails on the base.
    await expect(next).toBeVisible({ timeout: 15_000 });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(previous).toHaveCount(1);
      await expect(next).toHaveCount(1);
      await expect(jump).toBeVisible();
      await expect(period).toBeInViewport();
      const before = await previous.boundingBox(), after = await next.boundingBox();
      expect(Math.abs(before!.y - after!.y), "period arrows must remain on the same row").toBeLessThan(1);
      const text = period.locator("strong");
      if (week) {
        const start = addDays(nextMonday(value), -7);
        await expect(text).toHaveText(`${dayText(start)} – ${dayText(addDays(start, 6))}`);
      }
      expect((await text.boundingBox())!.width).toBeLessThan(after!.x - before!.x);
      if (screen.key === "attendance-close") {
        await expect(page.getByRole("heading", { level: 2, name: /월 마감/ })).toHaveCount(0);
        const grid = await page.getByRole("grid", { name: t("attendance.tab.close"), exact: true }).boundingBox();
        expect(grid!.y - after!.y - after!.height, "close rows follow the period control").toBeLessThan(100);
      }
      await fits(page, `${screen.key}/period/${width}/${theme}`);
      if (theme === "light") await expectAxe(page, `${screen.key}/period/${width}/${theme}`);
      await page.screenshot({ path: test.info().outputPath(`period-${width}.png`), fullPage: true });
    }
    await next.focus();
    await page.keyboard.press("Enter");
    await expect.poll(() => new URL(page.url()).searchParams.get(key)).toBe(week || day ? addDays(value, week ? 7 : 1) : shiftMonth(value, 1));
    await previous.focus();
    await page.keyboard.press("Space");
    await expect.poll(() => new URL(page.url()).searchParams.get(key)).toBe(value);
    await jump.click();
    await expect.poll(() => new URL(page.url()).searchParams.get(key)).toBe(week || day ? todayKst() : todayKst().slice(0, 7));
    for (const param of ["tab", "wp", "unit", week || day ? "month" : "date"]) {
      expect(new URL(page.url()).searchParams.get(param), `preserve ${param}`).toBe(initial.searchParams.get(param));
    }
    expect(fixture.unexpected).toEqual([]);
    fixture.release();
  });
}

test("first attendance entry follows the main menu @ui-state", async ({ page }) => {
  const fixture = await mockScreen(page, attendanceBoardScreens[0], "populated");
  await mockRoute(page, "get", "/api/v1/access/me", { status: 200, json: screenAccess("/attendance") });
  await page.goto("/");
  const link = page.getByRole("navigation", { name: "주 메뉴", exact: true }).getByRole("link", { name: "근태", exact: true });
  await expect(link).toBeVisible({ timeout: 15_000 });
  await link.evaluate(element => element.addEventListener("click", () => element.setAttribute("data-opened", "true")));
  await openAttendance(page, "menu");
  await expect(link).toHaveAttribute("data-opened", "true");
  await expect(page).toHaveURL(/\/attendance/);
  expect(fixture.unexpected).toEqual([]);
  fixture.release();
});

for (const view of ["holidays", "public"]) for (const theme of ["light", "dark"]) {
  test(`${view} year navigation in ${theme} @ui-state`, async ({ page }) => {
    await page.addInitScript(value => localStorage.setItem("console.theme", value), theme);
    const screen = attendanceBoardScreens.find(screen => screen.key === "attendance-calendar")!;
    const fixture = await mockScreen(page, screen, "populated");
    await mockRoute(page, "get", "/api/v1/attendance/holidays", request => ({ status: 200, json: {
      year: Number(new URL(request.url()).searchParams.get("year")), loaded: true, public: [], contractual: [],
    } }));
    await page.goto(`${screen.path}&view=${view}`);
    const period = page.getByRole("group", { name: "기간 이동", exact: true });
    const previous = page.getByRole("button", { name: t("attendanceHolidays.year.prev"), exact: true });
    const next = page.getByRole("button", { name: t("attendanceHolidays.year.next"), exact: true });
    const year = Number(todayKst().slice(0, 4));
    await expect(next).toBeVisible({ timeout: 15_000 });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(period.getByRole("button", { name: "올해", exact: true })).toBeVisible();
      await expect(period).toBeInViewport();
      expect(Math.abs((await next.boundingBox())!.y - (await previous.boundingBox())!.y)).toBeLessThan(1);
      await fits(page, `${view}/${width}/${theme}`);
      if (theme === "light") await expectAxe(page, `${view}/${width}/${theme}`);
      await page.screenshot({ path: test.info().outputPath(`period-${width}.png`), fullPage: true });
    }
    await previous.click();
    await expect(period.locator("strong")).toHaveText(t("attendanceHolidays.year", { year: year - 1 }));
    await next.click();
    await expect(period.locator("strong")).toHaveText(t("attendanceHolidays.year", { year }));
    await next.click();
    await period.getByRole("button", { name: "올해", exact: true }).click();
    await expect(period.locator("strong")).toHaveText(t("attendanceHolidays.year", { year }));
    expect(fixture.unexpected).toEqual([]);
    fixture.release();
  });
}
