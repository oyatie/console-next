// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { expectAxe, fits } from "../a11y";
import { attendanceReads } from "../mock/attendance";
import { AT, id } from "../mock/fixtures";
import { mockRoute } from "../mock/route";
import { mockScreen } from "../mock/screen";
import { screens } from "./registry";
import { attendanceScreens, type AttendanceState } from "./attendance";
import { attendanceReadState } from "./attendance-helpers";

test.beforeAll(() => loadCatalog("ko"));
const screen = attendanceScreens.find(candidate => candidate.key === "attendance-close")!;

for (const state of Object.keys(screen.states) as AttendanceState[]) for (const width of [1440, 390]) {
  test(`${screen.key}: ${state} at ${width}px @ui-state`, async ({ page }) => {
    await attendanceReadState(page, screen, state, width);
  });
}

for (const width of [1440, 390]) for (const theme of ["light", "dark"]) {
  test(`month close handoff facts at ${width}px in ${theme} @ui-state`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(value => localStorage.setItem("console.theme", value), theme);
    const fixture = { ...await mockScreen(page, screens[0], "populated"), ...await attendanceReads(page, screen, "populated") };
    await mockRoute(page, "get", "/api/v1/attendance/closes", { status: 200, json: {
      month: "2026-10", items: [
        { branch_scope: id(4), closed: false, open_exceptions: 7, pending_leave: 2 },
        { branch_scope: id(5), closed: true, open_exceptions: 0, pending_leave: 0, close: {
          id: id(800), month: "2026-10", branch_scope: id(5), checks: [], attested_by: id(1), attested_at: AT,
          closed_at: AT, period_lock_id: id(801), amendments: [],
        } },
        { branch_scope: id(6), closed: true, open_exceptions: 0, pending_leave: 0 },
      ],
    } });
    await page.goto("/attendance?tab=close&month=2026-10");
    const table = page.getByRole("grid", { name: t("attendance.tab.close"), exact: true });
    await expect(table.getByText("부산사업장", { exact: true })).toBeVisible();
    await expect(table.getByText(t("attendance.close.unavailable"), { exact: true })).toBeVisible();
    await expect(table.getByText(t("attendance.close.pendingLeave"), { exact: true }).first()).toBeVisible();
    await expect(table.getByText(t("attendance.count", { count: 2 }), { exact: true })).toBeVisible();
    const unlock = table.getByRole("link", { name: t("attendanceRecords.month.requestUnlock"), exact: true });
    await expect(unlock).toHaveCount(1);
    await expect(unlock).toHaveAttribute("href", `/people/period-locks?unlock=${id(801)}`);
    await expect(table.locator("time")).toHaveAttribute("datetime", AT);
    await expect(table.getByRole("button")).toHaveCount(0);
    await fits(page, `month-close/handoff/${width}/${theme}`);
    await expectAxe(page, `month-close/handoff/${width}/${theme}`);
    expect(fixture.forbidden).toEqual([]);
    expect(fixture.unexpected).toEqual([]);
    fixture.release();
  });
}

for (const width of [1440, 390]) for (const scope of ["all", "unavailable"] as const) {
  test(`month close ${scope} workplace label at ${width}px @ui-state`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
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
    await expect(table.getByText(t("attendance.count", { count: 0 }), { exact: true })).toHaveCount(2);
    await fits(page, `month-close/${scope}/${width}`);
    await expectAxe(page, `month-close/${scope}/${width}`);
    expect(fixture.forbidden).toEqual([]);
    expect(fixture.unexpected).toEqual([]);
  });
}
