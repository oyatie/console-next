// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, type Page } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { EXPERIENCE_KEY } from "../../apps/web/src/lib/prefs";
import { expectAxe, fits } from "../a11y";
import { test } from "../locale-fixture";
import { shot, withFullPage } from "../shots";
import { attendanceBoardScreens } from "../states/attendance";
import { screenAccess } from "./fixtures";
import { mockRoute } from "./route";
import { saeonAdminToken, saeonAdminUser, saeonUniverse } from "./saeon";
import { saeonAttendanceMonthGrid, saeonAttendancePersonMonth, saeonAttendanceScheduleTree, saeonOctoberDayKind } from "./attendance-saeon";
import { mockScreen } from "./screen";

test.beforeAll(() => loadCatalog("ko"));

async function enableConsoleExperience(page: Page, theme: "light" | "dark" = "light") {
  await page.addInitScript(
    ({ expKey, themeValue }) => {
      localStorage.setItem(expKey, "console");
      localStorage.setItem("console.theme", themeValue);
      localStorage.setItem("console.locale", "ko");
    },
    { expKey: EXPERIENCE_KEY, themeValue: theme },
  );
}

async function setupConsoleSaeonAttendance(page: Page, theme: "light" | "dark" = "light") {
  await enableConsoleExperience(page, theme);
  const screen = attendanceBoardScreens[0];
  const fixture = await mockScreen(page, screen, "populated");
  const monthGrid = saeonAttendanceMonthGrid();
  const tree = saeonAttendanceScheduleTree();

  const attendanceAccess = screenAccess("/attendance");
  const peopleAccess = screenAccess("/people");
  const orgAccess = screenAccess("/org");
  const payrollAccess = screenAccess("/payroll");
  const approvalsAccess = screenAccess("/approvals");

  await mockRoute(page, "post", "/api/v1/auth/token/refresh", { status: 200, json: saeonAdminToken() });
  await mockRoute(page, "get", "/api/v1/users/me", { status: 200, json: saeonAdminUser() });
  await mockRoute(page, "get", "/api/v1/access/me", {
    status: 200,
    json: {
      ...attendanceAccess,
      entries: [
        ...attendanceAccess.entries,
        ...peopleAccess.entries,
        ...orgAccess.entries,
        ...payrollAccess.entries,
        ...approvalsAccess.entries,
      ],
    },
  });
  await mockRoute(page, "get", "/api/v1/attendance/schedule/tree", { status: 200, json: tree });
  await mockRoute(page, "get", "/api/v1/attendance/month", { status: 200, json: monthGrid });
  await mockRoute(page, "get", "/api/v1/attendance/people/{employee_id}/month", request => {
    const parts = new URL(request.url()).pathname.split("/");
    const employeeId = parts.at(-2) ?? monthGrid.rows[0]!.employee_id;
    return { status: 200, json: saeonAttendancePersonMonth(employeeId, "2026-10") };
  });

  return { fixture, monthGrid };
}

for (const width of [1440, 390]) {
  for (const theme of ["light", "dark"] as const) {
    test(`Console /attendance Month (P5) renders Saeon team 1 with corrected calendar, stats, grid, and lower split at ${width}px ${theme}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      const { fixture, monthGrid } = await setupConsoleSaeonAttendance(page, theme);
      try {
        await page.goto("/attendance?month=2026-10");
        const pattern = page.locator('[data-pattern="month-grid"]');
        await expect(pattern).toBeVisible();
        await expect(page.getByRole("heading", { level: 1, name: t("attendance.title"), exact: true })).toBeVisible();

        const tabNav = pattern.getByRole("navigation", { name: t("attendance.tabs"), exact: true });
        await expect(tabNav).toBeVisible();

        // Corrected October 2026 stats: 12 people, 20 scheduled days, 2 weekday holidays, blocking > 0 disables Month Close.
        const statRow = pattern.locator("dl[aria-label]");
        await expect(statRow).toContainText(t("attendance.people", { count: 12 }));
        await expect(statRow).toContainText(saeonUniverse.hero.workSchedule.split(" · ")[0]!);
        await expect(statRow).toContainText(t("attendanceRecords.card.days", { count: 20 }));
        await expect(statRow).toContainText(t("attendanceRecords.card.days", { count: 2 }));

        const closeBtn = pattern.getByRole("button", { name: t("attendance.tab.close"), exact: true });
        await expect(closeBtn).toHaveAttribute("aria-disabled", "true");

        const grid = pattern.getByRole("grid", { name: t("attendanceRecords.grid.label"), exact: true });
        await expect(grid).toBeVisible();
        await expect(grid.getByText("0:00", { exact: true })).toHaveCount(0);
        await expect(grid.getByRole("link", { name: saeonUniverse.hero.name, exact: true })).toBeVisible();
        if (width === 1440) {
          await expect(grid).toContainText(t("attendance.monthConsole.grid.position"));
          await expect(grid).toContainText(`${saeonUniverse.hero.gradeLabel} · ${saeonUniverse.hero.roleLabel}`);
        }

        // Unapproved excess (3h + 2h) is counted in recognised totals, and Oct 2026 holidays are accurate (no Oct 6-7 holiday).
        expect(saeonOctoberDayKind(3)).toBe("PUBLIC_HOLIDAY");
        expect(saeonOctoberDayKind(5)).toBe("SUBSTITUTE_HOLIDAY");
        expect(saeonOctoberDayKind(6)).toBe("WORK");
        expect(saeonOctoberDayKind(7)).toBe("WORK");
        expect(saeonOctoberDayKind(9)).toBe("PUBLIC_HOLIDAY");
        const unapprovedMember = monthGrid.rows.find(r => r.totals.unrecognised > 0)!;
        expect(unapprovedMember.totals.recognised).toBeGreaterThan(20 * 480);

        await grid.getByRole("gridcell", { name: new RegExp(`^${saeonUniverse.hero.name} 2026-10-01`) }).click();

        if (width === 1440) {
          await expect(pattern).toContainText(t("attendanceRecords.recognition.basis"));
          await expect(grid).toContainText(t("attendance.monthConsole.grid.tailGroup"));
          await expect(grid).toContainText(t("attendance.monthConsole.grid.footer.workedHeadcount"));
          await expect(grid).toContainText(t("attendance.monthConsole.grid.footer.approvedOvertime"));
          const issuesTable = pattern.getByRole("grid", { name: t("attendance.monthConsole.bottom.issuesTitle"), exact: true });
          await expect(issuesTable).toBeVisible();
          await expect(issuesTable).toContainText(saeonUniverse.attendanceMonth.members[5]!.name);

          const layoutCheck = await page.evaluate(
            ({ heroName, heroCode, closeLabel, reviewLabel, statusLabel }) => {
              const main = document.getElementById("main");
              const status = document.querySelector<HTMLElement>(`footer[aria-label="${statusLabel}"]`);
              const buttons = [...document.querySelectorAll<HTMLElement>('[data-pattern="month-grid"] header button')];
              const gridBox = document.querySelector<HTMLElement>('[data-pattern="month-grid"] [role="grid"]')?.parentElement;
              const nameLink = [...document.querySelectorAll<HTMLAnchorElement>('[data-pattern="month-grid"] [role="grid"] tbody th a')].find(
                a => a.textContent?.trim() === heroName,
              );
              const activeRow = document.querySelector<HTMLElement>('[data-pattern="month-grid"] [role="grid"] tbody tr[data-active="true"]');
              const closeBtn = buttons.find(b => b.textContent?.trim() === closeLabel);
              const reviewBtn = buttons.find(b => b.textContent?.includes(reviewLabel));
              const day31Head = [...document.querySelectorAll<HTMLElement>('[data-pattern="month-grid"] [role="grid"] thead th')].find(
                th => th.firstElementChild?.textContent?.trim() === "31",
              );
              return {
                docScrollW: document.documentElement.scrollWidth,
                mainScrollH: main ? main.scrollHeight : 0,
                mainClientH: main ? main.clientHeight : 0,
                maxBtnHeight: Math.max(0, ...buttons.map(b => Math.round(b.getBoundingClientRect().height))),
                statusPresent: Boolean(status),
                statusText: status?.textContent ?? "",
                gridOverflowX: gridBox ? gridBox.scrollWidth - gridBox.clientWidth : 999,
                nameDecoration: nameLink ? getComputedStyle(nameLink).textDecorationLine : "",
                activeRowText: activeRow?.textContent ?? "",
                closeBorderStyle: closeBtn ? getComputedStyle(closeBtn).borderTopStyle : "",
                reviewIsPrimary: reviewBtn ? reviewBtn.classList.contains("btn--primary") : false,
                day31Visible: day31Head ? day31Head.getBoundingClientRect().right <= (gridBox?.getBoundingClientRect().right ?? 0) + 1 : false,
                heroCode,
              };
            },
            {
              heroName: saeonUniverse.hero.name,
              heroCode: saeonUniverse.hero.employeeNumber,
              closeLabel: t("attendance.tab.close"),
              reviewLabel: t("attendance.monthConsole.actions.reviewIssues"),
              statusLabel: t("shell.status.label"),
            },
          );
          expect(layoutCheck.docScrollW).toBeLessThanOrEqual(1440);
          expect(layoutCheck.mainScrollH).toBeLessThanOrEqual(layoutCheck.mainClientH + 1);
          expect(layoutCheck.maxBtnHeight).toBeLessThanOrEqual(36);
          expect(layoutCheck.gridOverflowX).toBeLessThanOrEqual(1);
          expect(layoutCheck.day31Visible).toBe(true);
          // Links are underlined at rest in Console, as ruled.
          expect(layoutCheck.nameDecoration).toBe("underline");
          expect(layoutCheck.activeRowText).toContain(saeonUniverse.hero.employeeNumber);
          expect(layoutCheck.statusText).toContain(saeonUniverse.hero.employeeNumber);
          expect(layoutCheck.statusText).toContain(t("attendance.monthConsole.status.issues", { count: 5 }));
          expect(layoutCheck.closeBorderStyle).toBe("solid");
          expect(layoutCheck.reviewIsPrimary).toBe(true);
        } else {
          // On 390px, StatRow wraps cleanly 2x3 with 0 overflow, toolbar pairs into 2 rows, day cols align cleanly, and bottom collapses to phoneBar at rest.
          const statMetrics = await statRow.evaluate(el => {
            const items = [...el.children].map(c => c.getBoundingClientRect());
            return {
              overflow: el.scrollWidth - el.clientWidth,
              rows: new Set(items.map(r => Math.round(r.top))).size,
            };
          });
          expect(statMetrics.overflow).toBeLessThanOrEqual(0);
          expect(statMetrics.rows).toBe(3);

          const phoneMetrics = await page.evaluate(
            ({ periodLabel, filterLabel, scopeLabel, closeLabel, openColHeader }) => {
              const header = document.querySelector<HTMLElement>('[data-pattern="month-grid"] header');
              const stepper = header?.querySelector<HTMLElement>(`[aria-label="${periodLabel}"]`);
              const select = header?.querySelector<HTMLElement>(`select[aria-label="${scopeLabel}"], [data-form-value]`);
              const seg = header?.querySelector<HTMLElement>(`[aria-label="${filterLabel}"]`);
              const closeBtn = [...(header?.querySelectorAll<HTMLElement>("button") ?? [])].find(b => b.textContent?.trim() === closeLabel);
              const grid = document.querySelector<HTMLElement>('[data-pattern="month-grid"] [role="grid"]');
              const headers = [...(grid?.querySelectorAll<HTMLElement>("thead th") ?? [])];
              const day7 = headers.find(th => th.firstElementChild?.textContent?.trim() === "7");
              const openHead = headers.find(th => th.textContent?.trim() === openColHeader);
              return {
                pair1Diff: stepper && select ? Math.abs(stepper.getBoundingClientRect().top - select.getBoundingClientRect().top) : 999,
                pair2Diff: seg && closeBtn ? Math.abs(seg.getBoundingClientRect().top - closeBtn.getBoundingClientRect().top) : 999,
                closeBorderStyle: closeBtn ? getComputedStyle(closeBtn).borderTopStyle : "",
                day7FitsBeforeOpen: day7 && openHead ? day7.getBoundingClientRect().right <= openHead.getBoundingClientRect().left + 1 : false,
              };
            },
            {
              periodLabel: t("attendance.period.label"),
              filterLabel: t("attendance.monthConsole.filter.label"),
              scopeLabel: t("attendanceRecords.scope.label"),
              closeLabel: t("attendance.tab.close"),
              openColHeader: t("attendanceRecords.total.open"),
            },
          );
          expect(phoneMetrics.pair1Diff).toBeLessThanOrEqual(8);
          expect(phoneMetrics.pair2Diff).toBeLessThanOrEqual(8);
          expect(phoneMetrics.closeBorderStyle).toBe("solid");
          expect(phoneMetrics.day7FitsBeforeOpen).toBe(true);

          const collapseBtn = pattern.getByRole("button", { name: t("attendance.monthConsole.bottom.collapse"), exact: true });
          await expect(collapseBtn).toHaveAttribute("aria-expanded", "true");
        }

        await withFullPage(page, () => shot(page, `attendance--${width}-${theme}`));
        await fits(page, `Console Attendance Month ${width} ${theme}`);
        await expectAxe(page, `Console Attendance Month ${width} ${theme}`);

        if (width === 390) {
          // Verify expanded bottom panel compact 2-line rows and recognition basis, plus collapse/expand toggle.
          const issuesTable = pattern.getByRole("grid", { name: t("attendance.monthConsole.bottom.issuesTitle"), exact: true });
          await expect(issuesTable).toBeVisible();
          await expect(pattern).toContainText(t("attendanceRecords.recognition.basis"));
          const rowHeights = await issuesTable.locator("tbody tr").evaluateAll(rows =>
            rows.map(r => Math.round(r.getBoundingClientRect().height)),
          );
          expect(rowHeights.every(h => h >= 44 && h <= 76)).toBe(true);
          const collapseBtn = pattern.getByRole("button", { name: t("attendance.monthConsole.bottom.collapse"), exact: true });
          await collapseBtn.click();
          const expandBtn = pattern.getByRole("button", { name: t("attendance.monthConsole.bottom.expand"), exact: true });
          await expect(expandBtn).toHaveAttribute("aria-expanded", "false");
          await expandBtn.click();
          await expect(collapseBtn).toHaveAttribute("aria-expanded", "true");
          await fits(page, `Console Attendance Month expanded ${width} ${theme}`);
          await expectAxe(page, `Console Attendance Month expanded ${width} ${theme}`);

          // Stress 320px width for zero horizontal bleed and clean 2x3 StatRow wrapping.
          await page.setViewportSize({ width: 320, height: 900 });
          const overflow320 = await page.evaluate(() => ({
            docW: document.documentElement.scrollWidth,
            statOverflow: document.querySelector("dl[aria-label]")!.scrollWidth - document.querySelector("dl[aria-label]")!.clientWidth,
          }));
          expect(overflow320.docW).toBeLessThanOrEqual(320);
          expect(overflow320.statOverflow).toBeLessThanOrEqual(0);
        }

        expect(fixture.unexpected).toEqual([]);
      } finally {
        fixture.release();
      }
    });
  }
}

test("Console /attendance Month supports Segmented filters, DayDock SidePane, and SaveDock SidePane", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { fixture } = await setupConsoleSaeonAttendance(page, "light");
  try {
    await page.goto("/attendance?month=2026-10");
    const pattern = page.locator('[data-pattern="month-grid"]');
    const grid = pattern.getByRole("grid", { name: t("attendanceRecords.grid.label"), exact: true });
    await expect(grid.locator("tbody tr")).toHaveCount(12);

    // Segmented filter: Exceptions only -> Overtime only -> All.
    const filterGroup = pattern.getByRole("group", { name: t("attendance.monthConsole.filter.label"), exact: true });
    await filterGroup.getByRole("button", { name: new RegExp(`^${t("attendance.monthConsole.filter.issues")}`) }).click();
    await expect(grid.locator("tbody tr")).toHaveCount(4);

    await filterGroup.getByRole("button", { name: new RegExp(`^${t("attendance.monthConsole.filter.overtime")}`) }).click();
    await expect(grid.locator("tbody tr")).toHaveCount(9);

    await filterGroup.getByRole("button", { name: t("home.inbox.filter.all"), exact: true }).click();
    await expect(grid.locator("tbody tr")).toHaveCount(12);

    // Click Inspect in open exceptions -> opens DayDock inside SidePane.
    const issuesTable = pattern.getByRole("grid", { name: t("attendance.monthConsole.bottom.issuesTitle"), exact: true });
    await issuesTable.getByRole("button", { name: t("attendance.monthConsole.bottom.checkAction"), exact: true }).first().click();
    const recordPane = page.locator('aside[data-pane="record"]');
    await expect(recordPane).toBeVisible();
    await expect(recordPane).toContainText(t("attendanceRecords.recognition.basis"));
    await recordPane.getByRole("button", { name: t("attendance.close"), exact: true }).last().click();
    await expect(recordPane).toHaveCount(0);

    // Draft a cell and press Ctrl+S -> opens SaveDock inside SidePane.
    const cell = grid.getByRole("gridcell", { name: new RegExp(`^${saeonUniverse.hero.name} 2026-10-06`) });
    await cell.dblclick();
    await page.keyboard.type("9-18");
    await page.keyboard.press("Enter");
    await page.keyboard.press("ControlOrMeta+s");
    await expect(recordPane).toBeVisible();
    await expect(recordPane).toContainText(t("attendanceRecords.evidence.PAPER_SHEET"));
    await recordPane.getByRole("button", { name: t("attendance.close"), exact: true }).last().click();
    await expect(recordPane).toHaveCount(0);

    expect(fixture.unexpected).toEqual([]);
  } finally {
    fixture.release();
  }
});

for (const state of ["loading", "empty", "failed", "refused"] as const) {
  for (const width of [1440, 390]) {
    test(`Console /attendance Month state sweep: ${state} at ${width}px passes layout & axe`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await enableConsoleExperience(page, "light");
      const fixture = await mockScreen(page, attendanceBoardScreens[0], state);
      try {
        await page.goto("/attendance?month=2026-10");
        const pattern = page.locator('[data-pattern="month-grid"]');
        await expect(pattern).toBeVisible();
        await expect(pattern.getByRole("navigation", { name: t("attendance.tabs"), exact: true })).toBeVisible();
        if (state === "loading") {
          await expect(pattern.getByRole("status", { name: t("common.loading"), exact: true })).toBeVisible();
          await fits(page, `Console Attendance loading ${width}`);
          await expectAxe(page, `Console Attendance loading ${width}`);
          fixture.release();
        } else if (state === "empty") {
          await expect(pattern.getByRole("heading", { name: t("attendanceRecords.empty.title"), exact: true })).toBeVisible();
          await fits(page, `Console Attendance empty ${width}`);
          await expectAxe(page, `Console Attendance empty ${width}`);
        } else if (state === "failed") {
          await expect(pattern.getByRole("heading", { name: t("common.loadFailed.title"), exact: true })).toBeVisible();
          await fits(page, `Console Attendance failed ${width}`);
          await expectAxe(page, `Console Attendance failed ${width}`);
        } else {
          await expect(pattern.getByRole("heading", { name: t("common.denied.title.plain"), exact: true })).toBeVisible();
          await fits(page, `Console Attendance refused ${width}`);
          await expectAxe(page, `Console Attendance refused ${width}`);
        }
        expect(fixture.unexpected).toEqual([]);
      } finally {
        fixture.release();
      }
    });
  }
}
