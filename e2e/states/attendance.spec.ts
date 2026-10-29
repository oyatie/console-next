// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import type { components } from "@console/api";
import { expectAxe, fits } from "../a11y";
import { expectStable, recordShifts } from "../stability";
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
      await expect(page.locator('[data-read-layout="list"]')).toBeVisible();
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
      const navBox = await nav.boundingBox();
      fixture.release();
      await expect(table).toBeVisible();
      expect(await nav.boundingBox()).toEqual(navBox);
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

test("a held date read reserves the day panel without the previous date's notice", async ({ page }) => {
  await page.addInitScript(recordShifts);
  const fixture = await mockScreen(page, screens[0], "populated");
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let requested = false;
  await mockRoute(page, "get", "/api/v1/attendance/schedule/tree", { status: 200, json: {
    date: "2026-10-04", people_total: 1, people_unscheduled: 1, holidays_loaded: true, nodes: [],
  } });
  await mockRoute(page, "get", "/api/v1/attendance/days", async request => {
    const date = new URL(request.url()).searchParams.get("date")!;
    if (date === "2026-10-03") { requested = true; await held; }
    const board: components["schemas"]["AttendanceDayBoard"] = {
      date, judged: date === "2026-10-03",
      ledger: { people: 1, no_schedule: 1, rest: 0, normal: 0, no_record: 0, pending: 0, missing_out: 0, absent: 0, outside: 0, trip: 0, late_or_early: 0 },
      marks: { blocking: 1, decision: 0, info: 0 },
      groups: [{ workplace_id: id(4), name: "본사", people: 1, normal: 0, no_schedule: 1,
        marks: { blocking: 1, decision: 0, info: 0 }, hidden: 0,
        rows: [{ employee_id: id(100), name: "검증직원", employee_number: "AT-1", own: false, month_state: { state: "OPEN" },
          day: { date, plan: { kind: "NO_SCHEDULE", holiday_work: false }, marks: ["NO_SCHEDULE"],
            recognition: { recorded: 0, recognised: 0, regular: 0, approved: 0, early_unrecognised: 0, late_unrecognised: 0, late_in: 0, early_out: 0, away: 0, approval_unused: 0 } } }],
      }],
    };
    return { status: 200, json: board };
  });
  const initialRead = page.waitForResponse(response => new URL(response.url()).pathname === "/api/v1/attendance/days" && response.ok());
  await page.goto("/attendance?tab=day&date=2026-10-04");
  await initialRead;
  const notice = page.getByText(t("attendanceRecords.board.notJudged"), { exact: true });
  await expect(notice).toBeVisible({ timeout: 15_000 });
  await expectStable(page, "initial day");
  const nav = page.getByRole("navigation", { name: t("attendance.tabs"), exact: true });
  const navBox = await nav.boundingBox();
  const previous = page.getByRole("button", { name: t("attendanceRecords.toolbar.prevDay"), exact: true });
  await previous.click();
  await expect.poll(() => requested).toBe(true);
  await expect(page.locator('[data-read-layout="grid"]')).toBeVisible();
  await expect(notice).toHaveCount(0);
  await expect(page.getByText(/^근태 대상/)).toHaveCount(0);
  expect(await nav.boundingBox()).toEqual(navBox);
  await expect(previous).toBeFocused();
  release();
  await expect(page.getByText(/^근태 대상 1명/)).toBeVisible();
  await expect(page.locator("[data-read-layout]")).toHaveCount(0);
  expect(await nav.boundingBox()).toEqual(navBox);
  await expect(previous).toBeFocused();
  await expectStable(page, "the new day replaces its reserved skeleton");
  expect(fixture.unexpected).toEqual([]);
});
