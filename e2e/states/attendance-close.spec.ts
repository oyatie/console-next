// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import type { components } from "@console/api";
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

const closed: components["schemas"]["AttendanceMonthClose"] = {
  id: id(800), month: "2026-10-01", branch_scope: "org", attested_by: id(1), attested_at: AT,
  closed_at: AT, period_lock_id: id(801), amendments: [], checks: [
    { key: "open_exceptions", ok: true, note: "0" },
    { key: "pending_leave", ok: true, warn: true, note: "2" },
    { key: "not_already_closed", ok: true },
  ],
};
const handoffs: { name: string; wp?: string; row: components["schemas"]["AttendanceMonthCloseItem"] }[] = [
  { name: "organization closed", row: { branch_scope: "org", closed: true, open_exceptions: 0, pending_leave: 2, close: closed } },
  { name: "organization open", row: { branch_scope: "org", closed: false, open_exceptions: 7, pending_leave: 2 } },
  { name: "workplace closed", wp: id(5), row: { branch_scope: id(5), closed: true, open_exceptions: 0, pending_leave: 0,
    close: { ...closed, branch_scope: id(5), period_lock_id: undefined, checks: closed.checks.map(check => check.key === "pending_leave" ? { ...check, warn: false, note: "0" } : check) } } },
];
for (const { name, wp, row } of handoffs) for (const width of [1440, 390]) for (const theme of ["light", "dark"]) {
  test(`month close ${name} handoff at ${width}px in ${theme} @ui-state`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(value => localStorage.setItem("console.theme", value), theme);
    const fixture = { ...await mockScreen(page, screens[0], "populated"), ...await attendanceReads(page, screen, "populated") };
    await mockRoute(page, "get", "/api/v1/attendance/closes", { status: 200, json: { month: "2026-10", items: [row] } });
    await page.goto(`/attendance?tab=close&month=2026-10${wp ? `&wp=${wp}` : ""}`);
    const table = page.getByRole("grid", { name: t("attendance.tab.close"), exact: true });
    await expect(table.getByText(wp ? "부산사업장" : t("attendanceRecords.scope.all", { count: 2 }), { exact: true })).toBeVisible();
    await expect(table.getByText(t("attendance.close.pendingLeave"), { exact: true }).first()).toBeVisible();
    await expect(table.getByText(t("attendance.count", { count: row.pending_leave }), { exact: true }).first()).toBeVisible();
    await expect(table.getByText(t(row.closed ? "attendance.close.closed" : "attendance.close.open"), { exact: true })).toBeVisible();
    const unlock = table.getByRole("link", { name: t("attendanceRecords.month.requestUnlock"), exact: true });
    await expect(unlock).toHaveCount(row.close?.period_lock_id ? 1 : 0);
    if (row.close?.period_lock_id) await expect(unlock).toHaveAttribute("href", `/people/period-locks?unlock=${row.close.period_lock_id}`);
    if (row.close) {
      await expect(table.locator("time")).toHaveAttribute("datetime", row.close.closed_at);
      await expect(table.locator("time")).not.toHaveText(/^[—–]$/);
    } else await expect(table.locator("time")).toHaveCount(0);
    if (width === 1440) await expect(table.getByRole("columnheader", { name: "기간 잠금", exact: true })).toBeVisible();
    await expect(table.getByText(t("attendanceRecords.month.locks"), { exact: true })).toHaveCount(0);
    await expect(table.getByRole("button")).toHaveCount(0);
    await fits(page, `month-close/${name}/${width}/${theme}`);
    await expectAxe(page, `month-close/${name}/${width}/${theme}`);
    await page.screenshot({ path: test.info().outputPath("handoff.png"), fullPage: true });
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
    await expect(table.getByText(t("attendance.count", { count: scope === "all" ? 7 : 0 }), { exact: true }).first()).toBeVisible();
    await fits(page, `month-close/${scope}/${width}`);
    await expectAxe(page, `month-close/${scope}/${width}`);
    expect(fixture.forbidden).toEqual([]);
    expect(fixture.unexpected).toEqual([]);
  });
}
