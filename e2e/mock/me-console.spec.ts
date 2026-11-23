// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { expectAxe, fits } from "../a11y";
import { test } from "../locale-fixture";
import { accountReads } from "./account";
import { failure, screenAccess } from "./fixtures";
import { mockRoute } from "./route";
import { saeonHeroProfile, saeonHeroScheduleMonth, saeonHeroToken, saeonHeroUser, saeonMyLeaveOverview } from "./saeon";
import {
  captureBuiltConsoleShot,
  enableConsole,
  saeonOwnAttendanceRecords,
  saeonOwnExceptions,
  saeonOwnWeek52,
} from "./saeon-mod5-6";
import { mockScreen } from "./screen";
import { screens } from "../states/registry";

test.beforeAll(() => loadCatalog("ko"));

const homeScreen = screens[0];

async function setupSelfService(
  page: Parameters<typeof mockScreen>[0],
  opts?: { theme?: "light" | "dark"; week52Available?: boolean; unplacedSchedule?: boolean },
) {
  await enableConsole(page, opts?.theme ?? "light");
  const fixture = await mockScreen(page, homeScreen, "populated");
  await accountReads(page, "save-unchanged");
  const access = screenAccess("/me/attendance");
  await mockRoute(page, "post", "/api/v1/auth/token/refresh", { status: 200, json: saeonHeroToken() });
  await mockRoute(page, "get", "/api/v1/users/me", { status: 200, json: saeonHeroUser() });
  await mockRoute(page, "get", "/api/v1/me/profile", { status: 200, json: saeonHeroProfile() });
  await mockRoute(page, "get", "/api/v2/me/leave", { status: 200, json: saeonMyLeaveOverview() });
  await mockRoute(page, "get", "/api/v1/access/me", {
    status: 200,
    json: {
      ...access,
      entries: [
        ...access.entries,
        {
          grant_id: "00000000-0000-4000-8610-000000000001",
          role_id: "00000000-0000-4000-8611-000000000001",
          role_name_ko: t("me.attendance.title"),
          domain: "attendance",
          level: "edit",
          enforcement: "ENFORCED",
          valid_from: "2026-01-01T00:00:00Z",
          scope: { kind: "DEPARTMENT", node_id: "00000000-0000-4000-8210-000000000001", include_descendants: false },
          caveats: [],
        },
      ],
    },
  });
  const baseCal = saeonHeroScheduleMonth("2026-11");
  const richCal = {
    ...baseCal,
    days: baseCal.days.map(d => (d.kind === "WORK" ? { ...d, shift: { start: 540, end: 1080, breaks: [{ start: 720, end: 780 }] } } : d)),
  };
  await mockRoute(
    page,
    "get",
    "/api/v1/attendance/me/schedule",
    opts?.unplacedSchedule ? { status: 403, json: failure("employee_not_placed") } : { status: 200, json: richCal },
  );
  await mockRoute(page, "get", "/api/v1/attendance/me/week52", {
    status: 200,
    json: saeonOwnWeek52(opts?.week52Available ?? true),
  });
  await mockRoute(page, "get", "/api/v1/attendance/me/exceptions", {
    status: 200,
    json: { items: saeonOwnExceptions(), total: 1, limit: 50, offset: 0 },
  });
  await mockRoute(page, "get", "/api/v1/hr/attendance-records/me", {
    status: 200,
    json: { items: saeonOwnAttendanceRecords(), total: 1, limit: 50, offset: 0 },
  });
  return { fixture };
}

for (const width of [1440, 390] as const) {
  for (const theme of ["light", "dark"] as const) {
    test(`Console /me/attendance and /me/desk pass layout & axe at ${width}px ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      const { fixture } = await setupSelfService(page, { theme, week52Available: true });
      try {
        await page.goto("/me/attendance");
        await expect(page.getByRole("heading", { level: 1, name: t("me.attendance.title"), exact: true })).toBeVisible();
        await expect(page.getByText(t("me.attendance.week52.hours", { hours: 34.5 }), { exact: false })).toBeVisible();
        await fits(page, `me-attendance ${width} ${theme}`);
        await expectAxe(page, `me-attendance ${width} ${theme}`);
        await captureBuiltConsoleShot(page, width, "me-attendance", theme);

        await page.goto("/me/desk");
        await expect(page.getByRole("heading", { level: 1, name: t("me.desk.title"), exact: true })).toBeVisible();
        await fits(page, `me-desk ${width} ${theme}`);
        await expectAxe(page, `me-desk ${width} ${theme}`);
        await captureBuiltConsoleShot(page, width, "me-desk", theme);

        expect(fixture.unexpected).toEqual([]);
      } finally {
        fixture.release();
      }
    });
  }
}

test("Console /me/attendance handles week52 not_available and unplaced schedule 403 without collapsing records", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { fixture } = await setupSelfService(page, { week52Available: false, unplacedSchedule: true });
  try {
    await page.goto("/me/attendance");
    await expect(page.getByText(t("me.attendance.week52.notAvailable")).first()).toBeVisible();
    await expect(page.getByText(t("me.attendance.schedule.refusedTitle"))).toBeVisible();
    await expect(page.getByText(t("me.attendance.records.title")).first()).toBeVisible();
    await expect(page.getByText(saeonOwnAttendanceRecords()[0]!.note!)).toBeVisible();

    await page.setViewportSize({ width: 390, height: 900 });
    await page.goto("/account");
    await expect(page.getByRole("link", { name: new RegExp(t("account.hub.attendance")) })).toBeVisible();

    expect(fixture.unexpected).toEqual([]);
  } finally {
    fixture.release();
  }
});
