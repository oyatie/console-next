// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { expectAxe, fits } from "../a11y";
import { attendanceReads } from "../mock/attendance";
import { mockScreen } from "../mock/screen";
import { attendanceScreens } from "./attendance";
import { screens } from "./registry";

test.beforeAll(() => loadCatalog("ko"));

for (const screen of attendanceScreens) for (const theme of ["light", "dark"]) {
  test(`${screen.key} period stays together and keeps scope in ${theme} @ui-state`, async ({ page }) => {
    await page.addInitScript(value => localStorage.setItem("console.theme", value), theme);
    const fixture = { ...await mockScreen(page, screens[0], "populated"), ...await attendanceReads(page, screen, "populated") };
    const week = screen.tab === "overtime";
    const previous = page.getByRole("button", { name: t(week ? "attendance.week.prev" : "attendanceRecords.toolbar.prevMonth"), exact: true });
    const next = page.getByRole("button", { name: t(week ? "attendance.week.next" : "attendanceRecords.toolbar.nextMonth"), exact: true });
    const initial = new URL(screen.path, "http://localhost");
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(screen.path);
    await expect(page.getByRole("grid", { name: t(`attendance.tab.${screen.tab}`), exact: true })).toBeVisible();

    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(previous).toHaveCount(1);
      await expect(next).toHaveCount(1);
      await page.screenshot({ path: test.info().outputPath(`period-${width}.png`), fullPage: true });
      const before = await previous.boundingBox(), after = await next.boundingBox();
      expect(before).not.toBeNull();
      expect(after).not.toBeNull();
      expect(Math.abs(before!.y - after!.y), "period arrows must remain on the same row").toBeLessThan(1);
      expect(after!.x).toBeGreaterThan(before!.x + before!.width);
      await fits(page, `${screen.key}/period/${width}/${theme}`);
      await expectAxe(page, `${screen.key}/period/${width}/${theme}`);
    }

    await next.focus();
    await page.keyboard.press("Enter");
    await expect.poll(() => new URL(page.url()).searchParams.get(week ? "date" : "month"))
      .toBe(week ? "2026-10-11" : "2026-11");
    await previous.focus();
    await page.keyboard.press("Space");
    await expect.poll(() => new URL(page.url()).searchParams.get(week ? "date" : "month"))
      .toBe(initial.searchParams.get(week ? "date" : "month"));
    const current = new URL(page.url());
    for (const key of ["tab", "wp", "unit", week ? "month" : "date"]) {
      expect(current.searchParams.get(key), `preserve ${key}`).toBe(initial.searchParams.get(key));
    }
    await expect(page.getByRole("grid", { name: t(`attendance.tab.${screen.tab}`), exact: true })).toBeVisible();
    expect(fixture.requests.map(request => request.query)).toEqual(expect.arrayContaining([
      expect.objectContaining({ branch_id: initial.searchParams.get("wp"), ...(week ? { week_start: "2026-10-05" } : { month: "2026-11" }) }),
    ]));
    expect(fixture.forbidden).toEqual([]);
    expect(fixture.unexpected).toEqual([]);
    fixture.release();
  });
}
