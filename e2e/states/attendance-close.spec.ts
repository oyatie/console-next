// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { expectAxe, fits } from "../a11y";
import { attendanceReads } from "../mock/attendance";
import { id } from "../mock/fixtures";
import { mockRoute } from "../mock/route";
import { mockScreen } from "../mock/screen";
import { screens } from "./registry";
import { attendanceScreens, type AttendanceState } from "./attendance";
import { attendanceReadState } from "./attendance-helpers";

test.beforeAll(() => loadCatalog("ko"));

for (const screen of [attendanceScreens[1]]) for (const state of Object.keys(screen.states) as AttendanceState[]) for (const width of [1440, 390]) {
  test(`${screen.key}: ${state} at ${width}px @ui-state`, async ({ page }) => {
    await attendanceReadState(page, screen, state, width);
  });
}

for (const width of [1440, 390]) for (const scope of ["all", "unavailable"] as const) {
  test(`month close ${scope} workplace label at ${width}px @ui-state`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const screen = attendanceScreens[1];
    const fixture = { ...await mockScreen(page, screens[0], "populated"), ...await attendanceReads(page, screen, "populated") };
    const path = new URL(screen.path, "http://localhost");
    if (scope === "all") path.searchParams.delete("wp");
    else {
      path.searchParams.set("wp", id(6));
      await mockRoute(page, "get", "/api/v1/attendance/closes", { status: 200, json: {
        month: "2026-10", items: [{ branch_scope: id(6), closed: false, open_exceptions: 0, pending_leave: 0 }],
      } });
    }
    await page.goto(path.pathname + path.search);
    const table = page.getByRole("grid", { name: t("attendance.tab.close"), exact: true });
    await expect(table.getByText(t(scope === "all" ? "attendanceRecords.scope.all" : "attendance.close.unavailable", { count: 2 }), { exact: true })).toBeVisible();
    if (scope === "all") {
      await expect(table.getByText(t("attendance.close.unavailable"), { exact: true })).toHaveCount(0);
      expect(fixture.requests.filter(request => request.path === screen.read).map(request => request.query.branch_id)).toEqual([undefined]);
    }
    await expect(table.getByText(t("attendance.close.open"), { exact: true })).toBeVisible();
    await expect(table.getByText(t("attendance.count", { count: 0 }), { exact: true })).toBeVisible();
    await fits(page, `month-close/${scope}/${width}`);
    await expectAxe(page, `month-close/${scope}/${width}`);
    expect(fixture.forbidden).toEqual([]);
    expect(fixture.unexpected).toEqual([]);
  });
}
