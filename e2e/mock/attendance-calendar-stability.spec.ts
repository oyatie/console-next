// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { expectAxe, fits } from "../a11y";
import { attendanceBoardScreens } from "../states/attendance";
import { mockScreen } from "./screen";
import { mockRoute } from "./route";
import { attendanceLayer } from "./attendance-board";

test.beforeAll(() => loadCatalog("ko"));

for (const width of [1440, 1280, 390]) for (const populated of [false, true]) {
  test(`calendar waits for ${populated ? "populated" : "empty"} history at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(() => localStorage.setItem("console.theme", "dark"));
    const screen = attendanceBoardScreens.find(s => s.key === "attendance-calendar")!;
    const fixture = await mockScreen(page, screen, "populated");
    const held = Promise.withResolvers<void>();
    const requested = Promise.withResolvers<void>();
    await mockRoute(page, "get", "/api/v1/attendance/schedule/layers", async () => {
      requested.resolve();
      await held.promise;
      return { status: 200, json: { items: populated ? [attendanceLayer] : [] } };
    });
    const calendar = page.waitForResponse(response => new URL(response.url()).pathname === screen.read);
    await page.goto(screen.path);
    await requested.promise;
    await (await calendar).finished();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const assign = page.getByRole("button", { name: t("attendanceSchedule.assign.open"), exact: true });
    try {
      // The history shares the calendar's grid row: exposing the action before it arrives moves the action.
      await expect(assign).toHaveCount(0);
    } finally { held.resolve(); }
    await expect(assign).toBeVisible();
    if (populated) await expect(page.getByRole("table", { name: t("attendanceSchedule.history.title") })).toBeVisible();
    else await expect(page.getByRole("heading", { name: t("attendanceSchedule.history.none"), exact: true })).toBeVisible();
    await assign.scrollIntoViewIfNeeded();
    const before = await assign.boundingBox();
    await fits(page, `calendar ${width}`);
    await expectAxe(page, `calendar ${width}`);
    expect(await assign.boundingBox()).toEqual(before);
    await page.screenshot({ path: test.info().outputPath("calendar.png") });
    expect(fixture.unexpected).toEqual([]);
  });
}
