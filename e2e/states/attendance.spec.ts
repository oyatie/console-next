// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { expectAxe, fits } from "../a11y";
import { attendanceReads, attendanceReference } from "../mock/attendance";
import { failure, id } from "../mock/fixtures";
import { mockRoute } from "../mock/route";
import { mockScreen } from "../mock/screen";
import { screens } from "./registry";
import { attendanceScreens, type AttendanceState } from "./attendance";

test.beforeAll(() => loadCatalog("ko"));
const tabs = ["day", "month", "overtime", "schedule", "issues", "close"] as const;
for (const screen of attendanceScreens) for (const state of Object.keys(screen.states) as AttendanceState[]) for (const width of [1440, 390]) {
  test(`${screen.key}: ${state} at ${width}px @ui-state`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const fixture = { ...await mockScreen(page, screens[0], "populated"), ...await attendanceReads(page, screen, state) };
    await page.goto(screen.path);
    const nav = page.getByRole("navigation", { name: t("attendance.tabs"), exact: true });
    await expect(nav).toBeVisible({ timeout: 15_000 });
    await expect(nav.getByRole("link")).toHaveText(tabs.map(tab => t(`attendance.tab.${tab}`)));
    await expect(nav.getByRole("link", { name: t(`attendance.tab.${screen.tab}`), exact: true })).toHaveAttribute("aria-current", "page");
    for (const tab of tabs) {
      const url = new URL((await nav.getByRole("link", { name: t(`attendance.tab.${tab}`), exact: true }).getAttribute("href"))!, page.url());
      expect(Object.fromEntries(url.searchParams)).toMatchObject({ tab, month: "2026-10", date: "2026-10-04", wp: id(4) });
    }
    const table = page.getByRole("grid", { name: t(`attendance.tab.${screen.tab}`), exact: true });
    if (state === "failed" || state === "refused") {
      await expect(page.getByText(t(state === "failed" ? "common.loadFailed.title" : "common.denied.title.plain"), { exact: true })).toBeVisible({ timeout: 15_000 });
      if (state === "refused") await page.getByText(t("common.denied.why"), { exact: true }).click();
      await expect(page.getByText(`ref ${attendanceReference.slice(0, 8)}`, { exact: true })).toBeVisible();
      await expect(table).toHaveCount(0);
    } else if (state === "loading") {
      await expect(page.getByRole("status", { name: t("common.loading"), exact: true })).toBeVisible();
      await expect(table).toHaveCount(0);
    } else {
      await expect(table).toBeVisible();
      if (state === "empty") await expect(table.getByText(t(`attendance.${screen.tab}.empty`), { exact: true })).toBeVisible();
      else if (screen.key === "attendance-close") {
        if (width === 1440) await expect(table.getByRole("columnheader")).toHaveText([t("attendance.col.workplace"), t("attendance.col.state"), t("attendance.tab.issues")]);
        await expect(table.getByText("본사", { exact: true })).toBeVisible();
        await expect(table.getByText(t("attendance.count", { count: 7 }), { exact: true })).toBeVisible();
        await expect(table.getByText(t("attendance.close.closed"), { exact: true })).toBeVisible();
      } else if (screen.key === "attendance-overtime") {
        await expect(table.getByText(t("attendance.hours", { hours: 32.5 }), { exact: true })).toBeVisible();
        await expect(table.getByText(t("attendance.hours", { hours: 1.5 }), { exact: true })).toBeVisible();
        await expect(table.getByText(t("attendance.overtime.UNKNOWN"), { exact: true })).toBeVisible();
        await expect(table.getByText(t("attendance.overtime.notReported"), { exact: true })).toHaveCount(2);
      } else {
        await expect(table.getByText("검증직원 1", { exact: true })).toBeVisible();
        await expect(table.getByText("검증직원 3", { exact: true })).toBeVisible();
        expect(fixture.requests.some(request => request.query.offset === "2")).toBe(true);
      }
    }
    await fits(page, `${screen.key}/${state}/${width}`);
    await expectAxe(page, `${screen.key}/${state}/${width}`);
    if (state === "loading") {
      fixture.release();
      await expect(table).toBeVisible();
    }
    expect(fixture.requests.filter(request => request.path === screen.read).length).toBeGreaterThan(0);
    for (const request of fixture.requests) expect(request.query).toMatchObject({ branch_id: id(4), ...(screen.key === "attendance-overtime" ? { week_start: "2026-09-28" } : { month: "2026-10" }), ...(screen.key === "attendance-issues" ? { status: "OPEN" } : {}) });
    expect(fixture.forbidden).toEqual([]);
    expect(fixture.unexpected, "register every supporting read").toEqual([]);
    expect(errors).toEqual([]);
  });
}

test("an exception opens its day under the fixed Today label", async ({ page }) => {
  const fixture = { ...await mockScreen(page, screens[0], "populated"), ...await attendanceReads(page, attendanceScreens[0], "populated") };
  await mockRoute(page, "get", "/api/v1/attendance/days", { status: 403, json: failure("forbidden") });
  await page.goto(attendanceScreens[0].path);
  await page.getByRole("grid").getByText("검증직원 1", { exact: true }).click();
  await expect.poll(() => Object.fromEntries(new URL(page.url()).searchParams)).toMatchObject({ tab: "day", date: "2026-10-01", month: "2026-10", wp: id(4) });
  await expect(page.getByRole("navigation", { name: t("attendance.tabs") }).getByRole("link", { name: t("attendance.tab.day"), exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page.getByText(t("common.denied.title.plain"), { exact: true })).toBeVisible();
  expect(fixture.forbidden).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});
