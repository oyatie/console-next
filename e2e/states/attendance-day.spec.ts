// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import type { components } from "@console/api";
import { expectAxe, fits } from "../a11y";
import { expectStable, recordShifts } from "../stability";
import { id } from "../mock/fixtures";
import { mockRoute } from "../mock/route";
import { mockScreen } from "../mock/screen";
import { screens } from "./registry";
import { attendanceBoardScreens, type AttendanceState } from "./attendance";
import { attendanceBoardState } from "./attendance-helpers";

test.beforeAll(() => loadCatalog("ko"));
const screen = attendanceBoardScreens.find(candidate => candidate.key === "attendance-day")!;

for (const state of Object.keys(screen.states) as AttendanceState[]) for (const width of [1440, 390]) {
  test(`${screen.key}: ${state} at ${width}px @ui-state`, async ({ page }) => {
    await attendanceBoardState(page, screen, state, width);
  });
}

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

for (const width of [1440, 390]) for (const colorScheme of ["light", "dark"] as const) test(`day board status and entry fields stay readable at ${width}px ${colorScheme}`, async ({ page }, testInfo) => {
  await page.emulateMedia({ colorScheme });
  await page.setViewportSize({ width, height: 900 });
  const fixture = await mockScreen(page, screen, "populated");
  await page.goto(screen.path);
  const input = page.getByRole("textbox", { name: /^근태직원 2 기록/ });
  await expect(input).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  const name = page.getByRole("link", { name: "근태직원 2", exact: true });
  expect((await input.boundingBox())!.width).toBeGreaterThan((await name.boundingBox())!.width);
  const status = page.getByText(t("attendanceRecords.mark.NO_RECORD"), { exact: true }).locator("..");
  // Sideways-scroll checks cannot detect text wrapping inside a collapsed column or overlapping fields.
  const layout = await status.evaluate(el => {
    const field = el.nextElementSibling!.getBoundingClientRect();
    const text = document.createRange();
    text.selectNodeContents(el);
    const overlaps = Array.from(text.getClientRects()).some(box => box.left < field.right && box.right > field.left && box.top < field.bottom && box.bottom > field.top);
    const brokenWords: string[] = [];
    for (const element of [el, el.nextElementSibling!.querySelector("label")!]) {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        for (const word of node.textContent!.matchAll(/\S+/g)) {
          const range = document.createRange();
          range.setStart(node, word.index!);
          range.setEnd(node, word.index! + word[0].length);
          if (range.getClientRects().length > 1) brokenWords.push(word[0]);
        }
      }
    }
    return { brokenWords, overlaps };
  });
  expect(layout).toEqual({ brokenWords: [], overlaps: false });
  await testInfo.attach("day-board", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
  for (const detail of [false, true]) {
    if (detail) await page.getByRole("button", { name: t("attendanceRecords.board.detail"), exact: true }).click();
    await expect(page.getByText("근태 기록 입력 방법", { exact: true })).toBeVisible();
    const hint = page.getByText(t("attendanceRecords.grammar.hint"), { exact: true });
    await expect(hint).toHaveCount(1);
    await expect(hint).toBeVisible();
    if (detail && width === 390) await page.getByRole("grid").evaluate(el => { el.scrollLeft = (el.scrollWidth - el.clientWidth) / 2; });
    const inputs = detail ? page.getByRole("textbox", { name: /^근태직원 \d+ 입력/ }) : input;
    await expect(inputs.first()).toBeVisible();
    for (const control of await inputs.all()) {
      await expect(control).toHaveAccessibleDescription(t("attendanceRecords.grammar.hint"));
      const target = await control.evaluate(el => {
        const { width, height } = el.getBoundingClientRect();
        return { width, height };
      });
      expect(target.width, "the board input is a pointer target").toBeGreaterThanOrEqual(24);
      expect(target.height, "the board input is a pointer target").toBeGreaterThanOrEqual(24);
      if (detail) {
        await control.evaluate(el => el.closest<HTMLElement>('[role="gridcell"], [role="rowheader"]')!.focus());
        await expect(control, "the editable board input remains the keyboard stop").toBeFocused();
        await page.keyboard.press("Shift+Tab");
        expect(await control.evaluate(el => document.activeElement === el.closest('[role="gridcell"], [role="rowheader"]')), "the card or cell adds no keyboard stop before its input").toBe(false);
      }
    }
    const editable = inputs.last();
    await editable.click();
    await page.keyboard.type("+2");
    await expect(editable).toHaveValue("+2");
    await expect(editable).toHaveAccessibleDescription(`${t("attendanceRecords.grammar.hint")} ${t("attendanceRecords.refusal.overtime_typed")}`);
    await editable.clear();
    await fits(page, `entry-hint/${detail}/${width}/${colorScheme}`);
    await expectAxe(page, `entry-hint/${detail}/${width}/${colorScheme}`);
  }
  expect(fixture.unexpected).toEqual([]);
});

for (const width of [1440, 390]) test(`day drawer retains readable board rows at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  const fixture = await mockScreen(page, screen, "populated");
  await page.goto(screen.path);
  await page.getByRole("button", { name: t("attendanceRecords.board.open"), exact: true }).click();
  await expect(page.getByRole(width === 1440 ? "complementary" : "dialog")).toBeVisible();
  const name = page.getByRole("link", { name: "근태직원 1", exact: true });
  const input = page.getByRole("textbox", { name: /^근태직원 2 기록/ });
  expect((await input.boundingBox())!.width).toBeGreaterThan((await name.boundingBox())!.width);
  expect(await name.evaluate(el => {
    const range = document.createRange();
    range.selectNodeContents(el);
    return range.getClientRects().length;
  })).toBe(1);
  await fits(page, `drawer/${width}`);
  await expectAxe(page, `drawer/${width}`);
  expect(fixture.unexpected).toEqual([]);
});
