// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { expectAxe, fits } from "../a11y";
import { attendanceDayBoard, attendancePerson } from "../mock/attendance-board";
import { AT, failure, id } from "../mock/fixtures";
import { mockScreen } from "../mock/screen";
import { attendanceBoardScreens } from "./attendance";

test.beforeAll(() => loadCatalog("ko"));
const screen = attendanceBoardScreens.find(s => s.key === "attendance-day")!;
const entry = { id: id(800), batch_id: id(801), kind: "TIMES", segments: [{ start: 540, end: 1200 }], source: "MANUAL", evidence_kind: "PAPER_SHEET", undone: false, created_at: AT, created_by_name: "근태담당" };
const intervals = [
  { start: 540, end: 720, minutes: 180, category: "WORK", recognised: true, reason: "소정 근무" },
  { start: 720, end: 780, minutes: 60, category: "BREAK", recognised: false, reason: "근무 일정의 휴게" },
  { start: 780, end: 1080, minutes: 300, category: "WORK", recognised: true, reason: "소정 근무" },
  { start: 1080, end: 1140, minutes: 60, category: "OVERTIME", recognised: true, reason: "사전 승인 없는 근로" },
  { start: 1140, end: 1200, minutes: 60, category: "NOT_WORK", recognised: false, reason: "개인 용무로 확인" },
];
const day = { ...attendancePerson.days[0]!, entry, intervals,
  plan: { kind: "WORK", holiday_work: false, shift: { start: 540, end: 1080, breaks: [{ start: 720, end: 780 }] } },
  recognition: { ...attendancePerson.days[0]!.recognition, recorded: 660, recognised: 540, regular: 480, outside_scheduled: 120, excess_open: 60, not_work: 60 }, marks: ["UNAPPROVED_EXCESS"],
};

for (const width of [1440, 390]) {
  test(`overview groups use served counts and preserve filters at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const fixture = await mockScreen(page, screen, "populated");
    const reads: URL[] = [];
    await page.route(url => url.pathname === screen.read, route => {
      const url = new URL(route.request().url());
      reads.push(url);
      if (url.searchParams.has("mark")) return route.fulfill({ status: 400, json: failure("invalid_query") });
      return route.fulfill({ json: { ...attendanceDayBoard, ledger: { ...attendanceDayBoard.ledger, people: 39, late_or_early: 37, normal: 1 }, issue_groups: [{ kind: "LATE", count: 37, earliest_date: "2026-10-04" }, { kind: "NO_RECORD", count: 0, earliest_date: "2026-10-01" }], groups: attendanceDayBoard.groups.map(group => ({ ...group, people: 39, hidden: 37 })) } });
    });
    await page.goto(`${screen.path}&wp=${id(4)}`);
    const groups = page.getByRole("grid", { name: "확인 필요 유형", exact: true });
    await expect(groups).toContainText("37");
    await expect(groups).toContainText("2026");
    await expect(groups.getByText(t("attendanceRecords.mark.NO_RECORD"), { exact: true })).toHaveCount(0);
    await groups.getByText(t("attendanceRecords.mark.LATE"), { exact: true }).click();
    await expect.poll(() => new URL(page.url()).searchParams.get("mark")).toBe("LATE");
    await expect(page.getByRole("link", { name: "근태직원 2", exact: true })).toBeVisible();
    await expect(groups).toBeVisible();
    expect(reads.at(-1)?.searchParams.get("workplace_id")).toBe(id(4));
    expect(reads.at(-1)?.searchParams.get("date")).toBe("2026-10-04");
    await page.getByRole("button", { name: t("attendanceOverview.issues.clear"), exact: true }).click();
    await expect.poll(() => new URL(page.url()).searchParams.has("mark")).toBe(false);
    await groups.getByText(t("attendanceRecords.mark.LATE"), { exact: true }).click();
    await expect.poll(() => new URL(page.url()).searchParams.get("mark")).toBe("LATE");
    await page.getByRole("button", { name: t("attendanceRecords.board.issuesOnly"), exact: true }).click();
    await expect.poll(() => new URL(page.url()).searchParams.has("mark")).toBe(false);
    await expect.poll(() => new URL(page.url()).searchParams.has("issues")).toBe(false);
    expect(reads.every(url => !url.searchParams.has("mark"))).toBe(true);
    await fits(page, `overview-groups/${width}`);
    await expectAxe(page, `overview-groups/${width}`);
    expect(fixture.unexpected).toEqual([]);
  });

  test(`day minutes and source chips explain recognition at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const fixture = await mockScreen(page, screen, "populated");
    await page.route(url => url.pathname === screen.read, route => route.fulfill({ json: { ...attendanceDayBoard, groups: [{ ...attendanceDayBoard.groups[0], rows: [{ ...attendanceDayBoard.groups[0]!.rows[0], day }] }] } }));
    await page.route(url => url.pathname === `/api/v1/attendance/people/${id(100)}/month`, route => route.fulfill({ json: { ...attendancePerson, days: [day], history: [{ date: day.date, entry: { ...entry, source: "PASTE", undone: true } }] } }));
    await page.goto(screen.path);
    await expect(page.getByText(t("attendanceRecords.source.MANUAL"), { exact: true })).toBeVisible();
    await page.getByRole("button", { name: t("attendanceRecords.board.open"), exact: true }).click();
    const dock = page.getByRole(width === 1440 ? "complementary" : "dialog");
    const minutes = dock.getByRole("table", { name: "분 단위 내역", exact: true });
    await expect(dock.getByRole("heading", { name: "분 단위 내역", exact: true })).toBeVisible();
    await expect(minutes.locator("tbody tr")).toHaveCount(5);
    await expect(minutes).toContainText("개인 용무로 확인");
    await expect(minutes).toContainText("60분");
    await expect(dock.getByText(/미승인 초과 1:00/)).toHaveCount(1);
    const bars = dock.getByRole("table", { name: t("uiShiftBar.table"), exact: true });
    await expect(bars.locator("tbody td").last()).toContainText("18:00–19:00");
    await expect(bars.locator("tbody td").last()).not.toContainText("20:00");
    await dock.getByRole("tab", { name: t("attendanceRecords.day.tab.source"), exact: true }).click();
    await expect(dock.getByText(t("attendanceRecords.source.MANUAL"), { exact: true })).toHaveClass(/chip/);
    await fits(page, `overview-drawer/${width}`);
    await expectAxe(page, `overview-drawer/${width}`);
    expect(fixture.unexpected).toEqual([]);
  });

  for (const current of [{ ...entry, undone: true }, { ...entry, kind: "VOID", source: "VOID", segments: [] }]) {
    test(`current source excludes ${current.undone ? "undone" : "voided"} entries at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      const fixture = await mockScreen(page, screen, "populated");
      await page.route(url => url.pathname === `/api/v1/attendance/people/${id(100)}/month`, route => route.fulfill({ json: { ...attendancePerson, days: [{ ...day, entry: current }], history: [{ date: day.date, entry: current }] } }));
      await page.goto(screen.path);
      await page.getByRole("button", { name: t("attendanceRecords.board.open"), exact: true }).click();
      const dock = page.getByRole(width === 1440 ? "complementary" : "dialog");
      await dock.getByRole("tab", { name: t("attendanceRecords.day.tab.source"), exact: true }).click();
      await expect(dock.getByText(t("attendanceRecords.day.noHistory"), { exact: true })).toBeVisible();
      await expect(dock.getByText(t(current.undone ? "attendanceRecords.source.MANUAL" : "attendanceRecords.source.VOID"), { exact: true })).toHaveCount(0);
      await dock.getByRole("tab", { name: t("attendanceRecords.day.tab.history"), exact: true }).click();
      await expect(dock.locator("s")).toHaveCount(1);
      await expect(dock.getByText(t(current.undone ? "attendanceRecords.source.MANUAL" : "attendanceRecords.source.VOID"), { exact: true })).toBeVisible();
      expect(fixture.unexpected).toEqual([]);
    });
  }
}

for (const state of ["empty", "failed", "refused", "loading"] as const) for (const width of [1440, 390]) {
  test(`overview details ${state} at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const fixture = await mockScreen(page, screen, "populated");
    let release!: () => void;
    let recovered = false;
    const held = new Promise<void>(resolve => { release = resolve; });
    await page.route(url => url.pathname === `/api/v1/attendance/people/${id(100)}/month`, async route => {
      if (state === "loading") await held;
      const status = !recovered && state === "failed" ? 500 : !recovered && state === "refused" ? 403 : 200;
      await route.fulfill({ status, json: status === 200 ? { ...attendancePerson, days: [state === "empty" ? { ...day, intervals: undefined } : day], history: [] } : failure(status === 403 ? "forbidden" : "internal") });
    });
    await page.goto(screen.path);
    await page.getByRole("button", { name: t("attendanceRecords.board.open"), exact: true }).click();
    const dock = page.getByRole(width === 1440 ? "complementary" : "dialog");
    if (state === "empty") {
      await expect(dock.getByRole("tab").first()).toBeVisible();
      await expect(dock.getByRole("table", { name: "분 단위 내역", exact: true })).toHaveCount(0);
      await expect(dock.getByText("분 단위 내역", { exact: true })).toHaveCount(0);
    }
    else if (state === "loading") await expect(dock.getByRole("status", { name: t("common.loading"), exact: true })).toBeVisible();
    else await expect(dock.getByRole("heading", { name: t(state === "failed" ? "common.loadFailed.title" : "common.denied.title.plain"), exact: true })).toHaveCount(1, { timeout: 15_000 });
    await fits(page, `overview-details/${state}/${width}`);
    await expectAxe(page, `overview-details/${state}/${width}`);
    if (state !== "empty") {
      recovered = true;
      if (state === "loading") release();
      else if (state === "failed") await dock.getByRole("button", { name: t("common.retry"), exact: true }).click();
      else {
        await page.reload();
        await page.getByRole("button", { name: t("attendanceRecords.board.open"), exact: true }).click();
      }
      const minutes = dock.getByRole("table", { name: "분 단위 내역", exact: true });
      await expect(minutes.locator("tbody tr")).toHaveCount(5);
      await expect(minutes).toContainText("개인 용무로 확인");
      await expect(dock.getByText(/미승인 초과 1:00/)).toHaveCount(1);
    }
    expect(fixture.unexpected).toEqual([]);
  });
}
