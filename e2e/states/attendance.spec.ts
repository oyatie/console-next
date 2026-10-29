// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import type { components } from "@console/api";
import { chooseRadio } from "../flows";
import { expectAxe, fits } from "../a11y";
import { expectStable, recordShifts } from "../stability";
import { attendanceReads, attendanceReference } from "../mock/attendance";
import { failure, id, screenAccess } from "../mock/fixtures";
import { mockRoute } from "../mock/route";
import { mockScreen } from "../mock/screen";
import { screens } from "./registry";
import { attendanceBoardScreens, attendanceScreens, type AttendanceState } from "./attendance";
import { attendanceDayBoard, attendancePerson, attendanceLayer } from "../mock/attendance-board";

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
      await expect(page.getByText(attendanceReference.slice(0, 8), { exact: true })).toBeVisible();
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

for (const screen of attendanceBoardScreens) for (const state of Object.keys(screen.states) as AttendanceState[]) for (const width of [1440, 390]) {
  test(`${screen.key}: ${state} at ${width}px @ui-state`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const fixture = await mockScreen(page, screen, state);
    await page.goto(screen.path);
    const nav = page.getByRole("navigation", { name: t("attendance.tabs"), exact: true });
    await expect(nav).toBeVisible();
    await expect(page.getByText("연동 예정", { exact: true })).toHaveCount(0);
    await expect(nav.getByRole("link")).toHaveText(tabs.map(tab => t(`attendance.tab.${tab}`)));
    expect(await nav.getByRole("link").evaluateAll(links => new Set(links.map(link => link.getBoundingClientRect().top)).size)).toBe(1);
    if (state === "failed" || state === "refused") {
      const title = t(state === "failed" ? "common.loadFailed.title" : "common.denied.title.plain");
      await expect(page.getByRole("heading", { name: title, exact: true })).toHaveCount(1, { timeout: 15_000 });
      await expect(page.getByRole("button", { name: t("attendanceSchedule.assign.open"), exact: true })).toHaveCount(0);
    } else if (state === "loading") {
      await expect(page.getByRole("status", { name: t("common.loading"), exact: true })).toBeVisible();
    } else if (state === "empty") {
      if (screen.key === "attendance-calendar") {
        await expect(page.getByRole("heading", { name: t("attendanceSchedule.calendar.empty"), exact: true })).toBeVisible();
        await expect(page.getByRole("button", { name: t("attendancePatterns.types.add"), exact: true })).toBeVisible();
      } else if (screen.key !== "attendance-person") await expect(page.getByRole("heading", { name: t("attendanceRecords.empty.title"), exact: true })).toBeVisible();
      else await expect(page.getByRole("heading", { name: /근태직원 1/ })).toBeVisible();
    } else if (screen.key === "attendance-day" || screen.key === "attendance-person") {
      const table = page.getByRole("table", { name: t("uiShiftBar.table"), exact: true });
      await expect(table).toHaveCount(1);
      await expect(table).toContainText("06:00 (+1)");
      await expect(page.getByText(t("uiShiftBar.scheduled"), { exact: true }).first()).toBeVisible();
      const boxes = await page.locator('svg[viewBox$=" 20"]').evaluateAll(bars => bars.map(bar => bar.getAttribute("viewBox")));
      expect(boxes.length).toBeGreaterThan(1);
      expect(new Set(boxes).size).toBe(1);
      if (screen.key === "attendance-person") await expect(page.getByText(t("attendance.dayKind.WEEKLY_HOLIDAY"), { exact: true })).toBeVisible();
      else await expect(page.getByText(t("attendanceRecords.mark.LATE"), { exact: true })).toBeVisible();
    } else if (screen.key === "attendance-month") {
      await expect(page.getByRole("grid", { name: t("attendanceRecords.grid.label"), exact: true })).toBeVisible();
      await expect(page.getByText(t("attendanceRecords.mark.NO_RECORD"), { exact: true })).toBeVisible();
      await expect(page.getByText(/◆0/)).toHaveCount(0);
    } else await expect(page.getByText(t("attendance.dayKind.WEEKLY_HOLIDAY"), { exact: true })).toBeVisible();
    await fits(page, `${screen.key}/${state}/${width}`);
    await expectAxe(page, `${screen.key}/${state}/${width}`);
    if (state === "loading") {
      const bounds = await nav.boundingBox();
      fixture.release();
      await expect(page.getByRole("status", { name: t("common.loading"), exact: true })).toHaveCount(0);
      expect(await nav.boundingBox()).toEqual(bounds);
    }
    expect(fixture.unexpected).toEqual([]);
  });
}

for (const width of [1440, 390]) test(`day drawer retains readable board rows at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  const fixture = await mockScreen(page, attendanceBoardScreens[1], "populated");
  await page.goto(attendanceBoardScreens[1].path);
  await page.getByRole("button", { name: t("attendanceRecords.board.open"), exact: true }).click();
  await expect(page.getByRole(width === 1440 ? "complementary" : "dialog")).toBeVisible();
  const name = page.getByRole("link", { name: "근태직원 1", exact: true });
  expect(await name.evaluate(el => {
    const range = document.createRange();
    range.selectNodeContents(el);
    return range.getClientRects().length;
  })).toBe(1);
  await fits(page, `drawer/${width}`);
  await expectAxe(page, `drawer/${width}`);
  expect(fixture.unexpected).toEqual([]);
});

test("a first-time user opens attendance from the main menu", async ({ page }) => {
  const fixture = await mockScreen(page, attendanceBoardScreens[0], "empty");
  await mockRoute(page, "get", "/api/v1/access/me", { status: 200, json: screenAccess("/attendance") });
  await page.goto("/");
  await page.getByRole("link", { name: "근태", exact: true }).click();
  await expect(page.getByRole("heading", { name: t("attendanceRecords.empty.title"), exact: true })).toBeVisible();
  await page.getByRole("link", { name: t("attendanceRecords.empty.toSchedule"), exact: true }).click();
  await page.getByRole("button", { name: t("attendancePatterns.types.add"), exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(fixture.unexpected).toEqual([]);
});

test("closed month board and card show the served lock state", async ({ page }) => {
  const fixture = await mockScreen(page, attendanceBoardScreens[1], "populated");
  await mockRoute(page, "get", "/api/v1/attendance/days", { status: 200, json: { ...attendanceDayBoard, groups: attendanceDayBoard.groups.map(group => ({ ...group, rows: group.rows.map(row => ({ ...row, month_state: { state: "CLOSED" as const } })) })) } });
  await mockRoute(page, "get", "/api/v1/attendance/people/{employee_id}/month", { status: 200, json: { ...attendancePerson, month_state: { state: "CLOSED" } } });
  await page.goto(attendanceBoardScreens[1].path);
  await expect(page.getByRole("link", { name: t("attendanceRecords.month.locks"), exact: true })).toBeVisible();
  await expect(page.getByRole("textbox")).toHaveCount(0);
  await page.getByRole("link", { name: "근태직원 1", exact: true }).click();
  await expect(page.getByText(t("attendanceRecords.card.closed", { month: "2026년 10월" }), { exact: true })).toBeVisible();
  expect(fixture.unexpected).toEqual([]);
});

for (const sheet of ["cancel", "undo"] as const) for (const state of ["populated", "empty", "failed", "refused", "loading"] as const) for (const width of [1440, 390]) {
  test(`${sheet} sheet ${state} at ${width}px @ui-state`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const screen = attendanceBoardScreens[sheet === "cancel" ? 3 : 0];
    const fixture = await mockScreen(page, screen, "populated");
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let sent = false;
    await page.route(url => url.pathname === (sheet === "cancel" ? `/api/v1/attendance/schedule/layers/${attendanceLayer.id}/cancel` : `/api/v1/attendance/batches/${id(702)}/undo`), async route => {
      sent = true;
      if (state === "loading") await held;
      const status = state === "failed" ? 500 : state === "refused" ? 403 : 200;
      const json = status !== 200 ? failure(status === 403 ? "forbidden" : "internal") : sheet === "cancel" ? { ...attendanceLayer, state: "CANCELLED" } : { batch_id: id(702), saved: 1, unchanged: 0, closes: { blocking: 0, decision: 0, info: 0 }, opens: { blocking: 0, decision: 0, info: 0 } };
      if (!page.isClosed()) await route.fulfill({ status, json });
    });
    await page.goto(screen.path);
    if (sheet === "cancel") await page.getByRole("button", { name: t("attendanceSchedule.history.cancelOne", { pattern: attendanceLayer.pattern_name }), exact: true }).click();
    else {
      const cell = page.getByRole("gridcell", { name: /^근태직원 1 2026-10-01/ });
      await cell.dblclick();
      await page.keyboard.type("9-18");
      await page.keyboard.press("Enter");
      await page.getByRole("button", { name: t("attendanceRecords.toolbar.save"), exact: true }).click();
      const save = page.getByRole(width === 1440 ? "complementary" : "dialog");
      await chooseRadio(save, /출근부 \(종이\)/);
      await expect(save.getByRole("textbox", { name: /^메모/ })).toHaveAttribute("maxlength", "500");
      await save.getByRole("button", { name: t("attendanceRecords.save.commit", { count: 1 }), exact: true }).click();
      await page.getByRole("button", { name: t("attendanceRecords.receipt.undo"), exact: true }).click();
    }
    const dialog = page.getByRole("dialog", { name: t(sheet === "cancel" ? "attendanceSchedule.cancel.title" : "attendanceRecords.undo.title"), exact: true });
    await expect(dialog).toBeVisible();
    const submit = dialog.getByRole("button", { name: t(sheet === "cancel" ? "attendanceSchedule.cancel.commit" : "attendanceRecords.undo.commit", { count: 1 }), exact: true });
    if (state === "empty") {
      await expect(submit).toHaveAttribute("aria-disabled", "true");
      expect(sent).toBe(false);
    } else {
      await dialog.getByRole("textbox", { name: sheet === "cancel" ? /^취소 사유/ : /^사유/ }).fill("담당자가 기록을 확인했습니다");
      await submit.click();
      await expect.poll(() => sent).toBe(true);
      if (state === "populated") await expect(dialog).toHaveCount(0);
      else if (state === "loading") await expect(dialog.getByRole("button", { name: t("attendance.close"), exact: true }).first()).toBeDisabled();
      else if (state === "failed") await expect(dialog.getByRole("status").filter({ hasText: t("requestOutcome.checking") })).toBeVisible();
      else await expect(dialog.getByRole("alert")).toBeVisible();
    }
    await fits(page, `${sheet}/${state}/${width}`);
    await expectAxe(page, `${sheet}/${state}/${width}`);
    if (state === "loading") { release(); await expect(dialog).toHaveCount(0); }
    expect(fixture.unexpected).toEqual([]);
  });
}
