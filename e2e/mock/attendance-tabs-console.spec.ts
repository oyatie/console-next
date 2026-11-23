// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { expectAxe, fits } from "../a11y";
import { test } from "../locale-fixture";
import { screenAccess } from "./fixtures";
import { mockRoute } from "./route";
import { saeonAdminToken, saeonAdminUser, saeonLegalEntities, saeonUniverse } from "./saeon";
import { saeonAttendancePersonMonth, saeonAttendanceScheduleTree } from "./attendance-saeon";
import {
  captureBuiltConsoleShot,
  enableConsole,
  saeonAttendanceCloses,
  saeonAttendanceDayBoard,
  saeonAttendanceExceptionsPage,
  saeonAttendanceScheduleCalendar,
  saeonAttendanceScheduleLayers,
  saeonAttendanceWeek52Board,
} from "./saeon-mod5-6";
import { mockScreen } from "./screen";
import { attendanceBoardScreens } from "../states/attendance";

test.beforeAll(() => loadCatalog("ko"));

async function setupAttendanceTabs(page: Parameters<typeof mockScreen>[0], theme: "light" | "dark" = "light") {
  await enableConsole(page, theme);
  const fixture = await mockScreen(page, attendanceBoardScreens[1], "populated");
  const access = screenAccess("/attendance");
  const dayBoard = saeonAttendanceDayBoard();
  const week52 = saeonAttendanceWeek52Board();
  const exceptionsPage = saeonAttendanceExceptionsPage();
  const closes = saeonAttendanceCloses();
  const tree = saeonAttendanceScheduleTree();

  await mockRoute(page, "post", "/api/v1/auth/token/refresh", { status: 200, json: saeonAdminToken() });
  await mockRoute(page, "get", "/api/v1/users/me", { status: 200, json: saeonAdminUser() });
  await mockRoute(page, "get", "/api/v1/access/me", { status: 200, json: access });
  await mockRoute(page, "get", "/api/v1/legal-entities", { status: 200, json: saeonLegalEntities() });
  await mockRoute(page, "get", "/api/v1/branches", {
    status: 200,
    json: saeonUniverse.entities[0]!.workplaces.map(w => ({
      id: w.id,
      region_id: "00000000-0000-4000-8190-000000000001",
      name: w.name,
      deactivated_at: null,
      created_at: "2026-01-01T00:00:00Z",
    })),
  });
  await mockRoute(page, "get", "/api/v1/attendance/schedule/tree", { status: 200, json: tree });
  await mockRoute(page, "get", "/api/v1/attendance/days", { status: 200, json: dayBoard });
  await mockRoute(page, "get", "/api/v1/attendance/week52", { status: 200, json: week52 });
  await mockRoute(page, "get", "/api/v1/attendance/exceptions", { status: 200, json: exceptionsPage });
  await mockRoute(page, "get", "/api/v1/attendance/exceptions/{exception_id}", req => {
    const id = new URL(req.url()).pathname.split("/").at(-1);
    const hit = exceptionsPage.items.find(i => i.id === id) ?? exceptionsPage.items[0]!;
    return { status: 200, json: hit };
  });
  await mockRoute(page, "get", "/api/v1/attendance/closes", { status: 200, json: { month: "2026-10", ...closes } });
  await mockRoute(page, "get", "/api/v1/attendance/schedule/layers", { status: 200, json: saeonAttendanceScheduleLayers() });
  await mockRoute(page, "get", "/api/v1/attendance/schedule/calendar", req => {
    const q = new URL(req.url()).searchParams;
    const scopeKind = (q.get("scope_kind") ?? "WORKPLACE") as "LEGAL_ENTITY" | "WORKPLACE" | "DEPARTMENT" | "CREW" | "PERSON";
    const scopeId = q.get("scope_id") ?? saeonUniverse.entities[0]!.workplaces[1]!.id;
    const month = q.get("month") ?? "2026-10";
    return { status: 200, json: saeonAttendanceScheduleCalendar(scopeKind, scopeId, month) };
  });
  await mockRoute(page, "get", "/api/v1/attendance/people/{employee_id}/month", req => {
    const employeeId = new URL(req.url()).pathname.split("/").at(-2) ?? dayBoard.groups[0]!.rows[0]!.employee_id;
    return { status: 200, json: saeonAttendancePersonMonth(employeeId, "2026-10") };
  });

  return { fixture, exceptionsPage, dayBoard };
}

for (const width of [1440, 390] as const) {
  for (const theme of ["light", "dark"] as const) {
    test(`Console /attendance non-month tabs render cleanly at ${width}px ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      const { fixture } = await setupAttendanceTabs(page, theme);
      try {
        await page.goto("/attendance?tab=day&date=2026-10-15");
        await expect(page.getByRole("heading", { level: 1, name: t("attendance.title"), exact: true })).toBeVisible();
        await fits(page, `att-day ${width} ${theme}`);
        await expectAxe(page, `att-day ${width} ${theme}`);
        await captureBuiltConsoleShot(page, width, "attendance-day", theme);

        await page.goto("/attendance?tab=overtime&date=2026-10-15");
        await expect(page.getByRole("grid", { name: t("attendance.tab.overtime"), exact: true })).toBeVisible();
        await expect(page.getByText(t("attendance.monthConsole.grid.footer.approvedOvertime"))).toHaveCount(0);
        await fits(page, `att-overtime ${width} ${theme}`);
        await expectAxe(page, `att-overtime ${width} ${theme}`);
        await captureBuiltConsoleShot(page, width, "attendance-overtime", theme);

        await page.goto("/attendance?tab=issues&month=2026-10");
        await expect(page.getByRole("grid", { name: t("attendance.tab.issues"), exact: true })).toBeVisible();
        await fits(page, `att-issues ${width} ${theme}`);
        await expectAxe(page, `att-issues ${width} ${theme}`);
        await captureBuiltConsoleShot(page, width, "attendance-issues", theme);

        await page.goto("/attendance?tab=close&month=2026-10");
        await expect(page.getByRole("grid", { name: t("attendance.tab.close"), exact: true })).toBeVisible();
        await fits(page, `att-close ${width} ${theme}`);
        await expectAxe(page, `att-close ${width} ${theme}`);
        await captureBuiltConsoleShot(page, width, "attendance-close", theme);

        await page.goto("/attendance?tab=schedule&month=2026-10");
        await expect(page.getByRole("navigation", { name: t("attendance.views"), exact: true })).toBeVisible();
        await fits(page, `att-schedule ${width} ${theme}`);
        await expectAxe(page, `att-schedule ${width} ${theme}`);
        await captureBuiltConsoleShot(page, width, "attendance-schedule", theme);

        expect(fixture.unexpected).toEqual([]);
      } finally {
        fixture.release();
      }
    });
  }
}

test("Console /attendance Issues opens detail pane via exceptionDetailQuery and PersonCard opens RecordPattern", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { fixture, exceptionsPage, dayBoard } = await setupAttendanceTabs(page, "light");
  try {
    await page.goto("/attendance?tab=issues&month=2026-10");
    await page.getByText(exceptionsPage.items[0]!.employee_name, { exact: true }).first().click();
    const pane = page.locator('aside[data-pane="record"]');
    await expect(pane).toBeVisible();
    await expect(pane).toContainText(exceptionsPage.items[0]!.detail);

    await page.goto(`/attendance?tab=month&month=2026-10&person=${dayBoard.groups[0]!.rows[0]!.employee_id}`);
    await expect(page.locator('[data-pattern="record"]')).toBeVisible();
    expect(fixture.unexpected).toEqual([]);
  } finally {
    fixture.release();
  }
});
