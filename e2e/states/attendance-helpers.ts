// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, type Page } from "@playwright/test";
import { t } from "@console/i18n";
import { chooseRadio } from "../flows";
import { expectAxe, fits } from "../a11y";
import { attendanceReads, attendanceReference } from "../mock/attendance";
import { attendanceLayer } from "../mock/attendance-board";
import { failure, id } from "../mock/fixtures";
import { mockScreen } from "../mock/screen";
import { screens } from "./registry";
import { attendanceBoardScreens, attendanceScreens, type AttendanceState } from "./attendance";

const tabs = ["day", "month", "overtime", "schedule", "issues", "close"] as const;

export async function attendanceReadState(page: Page, screen: typeof attendanceScreens[number], state: AttendanceState, width: number) {
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
}

export async function attendanceBoardState(page: Page, screen: typeof attendanceBoardScreens[number], state: AttendanceState, width: number) {
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
}

export async function attendanceSheetState(page: Page, sheet: "cancel" | "undo", state: AttendanceState, width: number) {
  await page.setViewportSize({ width, height: 900 });
  const screen = attendanceBoardScreens.find(candidate => candidate.key === (sheet === "cancel" ? "attendance-calendar" : "attendance-month"))!;
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
    const memo = save.getByRole("textbox", { name: /^메모/ });
    await expect(memo).toHaveAttribute("maxlength", "500");
    await expect(memo).toHaveAccessibleDescription(t("attendanceRecords.evidence.note.hint", { limit: Number(await memo.getAttribute("maxlength")) }));
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
}
