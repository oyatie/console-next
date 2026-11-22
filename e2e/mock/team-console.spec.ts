// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { expectAxe, fits } from "../a11y";
import { test } from "../locale-fixture";
import { authz } from "../mock/fixtures";
import { mockRoute } from "../mock/route";
import { saeonHeroToken, saeonHeroUser } from "../mock/saeon";
import {
  captureBuiltConsoleShot,
  enableConsole,
  saeonTeamAccess,
  saeonTeamEmployees,
  saeonTeamFacets,
  saeonTeamLeaveQueue,
} from "../mock/saeon-mod5-6";
import { mockScreen } from "../mock/screen";
import { screens } from "../states/registry";

test.beforeAll(() => loadCatalog("ko"));

const teamScreen = screens.find(s => s.key === "team")!;

async function setupSaeonTeam(
  page: Parameters<typeof mockScreen>[0],
  opts?: { theme?: "light" | "dark"; canManage?: boolean; tenantWide?: boolean; concurrent?: boolean },
) {
  await enableConsole(page, opts?.theme ?? "light");
  const fixture = await mockScreen(page, teamScreen, "populated");
  let orgStructureCalled = false;
  page.on("request", req => {
    if (new URL(req.url()).pathname.includes("/org-structure")) orgStructureCalled = true;
  });

  const empPage = saeonTeamEmployees();
  await mockRoute(page, "post", "/api/v1/auth/token/refresh", { status: 200, json: saeonHeroToken() });
  await mockRoute(page, "get", "/api/v1/users/me", { status: 200, json: saeonHeroUser() });
  await mockRoute(page, "get", "/api/v1/me/authz", {
    status: 200,
    json: {
      ...authz,
      capabilities: (opts?.canManage
        ? ["employee_directory_read", "employee_directory_manage", "org_change_read"]
        : ["employee_directory_read", "org_change_read"]
      ).map(feature => ({ feature, permission: "allow" as const, branch_scope: { kind: "all" as const }, org_wide: true, scoped: false })),
    },
  });
  await mockRoute(page, "get", "/api/v1/access/me", {
    status: 200,
    json: saeonTeamAccess({
      concurrent: opts?.concurrent ?? true,
      tenantWide: opts?.tenantWide ?? false,
      canManage: opts?.canManage ?? true,
    }),
  });
  await mockRoute(page, "get", "/api/v1/employees", { status: 200, json: empPage });
  await mockRoute(page, "get", "/api/v1/employees/facets", { status: 200, json: saeonTeamFacets() });
  await mockRoute(page, "get", "/api/v2/leave/requests", { status: 200, json: saeonTeamLeaveQueue(empPage.items) });

  return { fixture, empPage, orgStructureCalled: () => orgStructureCalled };
}

for (const width of [1440, 390] as const) {
  for (const theme of ["light", "dark"] as const) {
    test(`Console /team renders Cedar-scoped roster and side pane at ${width}px ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      const { fixture, empPage, orgStructureCalled } = await setupSaeonTeam(page, { theme, canManage: true, concurrent: true });
      try {
        await page.goto(width === 1440 ? `/team?sel=${empPage.items[0]!.id}` : "/team");
        await expect(page.getByRole("heading", { level: 1, name: t("team.title"), exact: true })).toBeVisible();
        await expect(page.getByRole("button", { name: t("team.view.all"), exact: true })).toBeVisible();
        await expect(page.getByRole("button", { name: t("team.view.direct"), exact: true })).toBeVisible();
        await expect(page.getByRole("button", { name: t("team.view.concurrent"), exact: true })).toBeVisible();
        await expect(page.getByText(empPage.items[0]!.name, { exact: true }).first()).toBeVisible();

        if (width === 1440) {
          const pane = page.locator('aside[data-pane="record"]');
          await expect(pane).toBeVisible();
          await expect(pane).toContainText(t("team.pane.action.openCard"));
          await expect(pane).toContainText(t("team.pane.action.appoint"));
        }

        await fits(page, `team console ${width} ${theme}`);
        await expectAxe(page, `team console ${width} ${theme}`);
        await captureBuiltConsoleShot(page, width, "team", theme);

        expect(orgStructureCalled()).toBe(false);
        expect(fixture.unexpected).toEqual([]);
      } finally {
        fixture.release();
      }
    });
  }
}

test("Console /team hides management actions when directory manage capability is absent", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { fixture, empPage, orgStructureCalled } = await setupSaeonTeam(page, { canManage: false, concurrent: true });
  try {
    await page.goto(`/team?sel=${empPage.items[0]!.id}`);
    const pane = page.locator('aside[data-pane="record"]');
    await expect(pane).toBeVisible();
    await expect(pane).toContainText(t("team.pane.action.openCard"));
    await expect(pane).not.toContainText(t("team.pane.action.appoint"));
    await expect(pane).not.toContainText(t("team.pane.action.leave"));
    await expect(pane).not.toContainText(t("team.pane.action.changeRequest"));
    expect(orgStructureCalled()).toBe(false);
    expect(fixture.unexpected).toEqual([]);
  } finally {
    fixture.release();
  }
});

test("Console /team updates StatRow and StatusBar counts in direct view", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { fixture } = await setupSaeonTeam(page, { canManage: true, concurrent: true });
  try {
    await page.goto("/team");
    await expect(page.getByText(t("team.status.scopeCount", { count: 8 }))).toBeVisible();
    await page.getByRole("button", { name: t("team.view.direct"), exact: true }).click();
    await expect(page.getByText(t("team.status.scopeCount", { count: 5 }))).toBeVisible();
    await expect(page.locator(`dl[aria-label="${t("team.stats.label")}"]`)).toContainText("5");
    expect(fixture.unexpected).toEqual([]);
  } finally {
    fixture.release();
  }
});
