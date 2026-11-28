// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { expectAxe, fits } from "../a11y";
import { test } from "../locale-fixture";
import { authz } from "../mock/fixtures";
import { mockRoute } from "../mock/route";
import { saeonHeroToken, saeonHeroUser, saeonUniverse } from "../mock/saeon";
import {
  captureBuiltConsoleShot,
  enableConsole,
  saeonTeamAccess,
  saeonTeamEmployees,
  saeonTeamFacets,
  saeonTeamLeaveQueue,
} from "../mock/saeon-mod5-6";
import { mockScreen } from "../mock/screen";
import { teamScreen } from "../states/registry";

test.beforeAll(() => loadCatalog("ko"));

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
  await mockRoute(page, "get", "/api/v1/users/me", { status: 200, json: { ...saeonHeroUser(), employee_org_unit_id: "00000000-0000-4000-8210-000000000001" } });
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
  await mockRoute(page, "get", "/api/v1/employees", req => {
    const unit = new URL(req.url()).searchParams.get("org_unit_id");
    const items = unit ? empPage.items.filter(person => person.org_unit_id === unit) : empPage.items;
    return { status: 200, json: { ...empPage, items, total: items.length } };
  });
  await mockRoute(page, "get", "/api/v1/employees/facets", req => {
    const query = new URL(req.url()).searchParams;
    const unit = query.get("org_unit_id");
    const items = unit ? empPage.items.filter(person => person.org_unit_id === unit) : empPage.items;
    const total = query.has("contract_ending_on_or_after") ? 0 : items.length;
    return { status: 200, json: { ...saeonTeamFacets(), total } };
  });
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

test("Console /team concurrent view scopes attentionCount and leave banner to the active scope", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await enableConsole(page, "light");
  const fixture = await mockScreen(page, teamScreen, "populated");
  const allEmployees = saeonTeamEmployees();
  const scope1Employees = allEmployees.items.slice(0, 2);
  const scope2Employees = allEmployees.items.slice(2, 4);
  const scope1Leave = saeonTeamLeaveQueue(scope1Employees).items.slice(0, 1);
  const ulsanId = saeonUniverse.entities[0]!.workplaces[0]!.id;

  await mockRoute(page, "post", "/api/v1/auth/token/refresh", { status: 200, json: saeonHeroToken() });
  await mockRoute(page, "get", "/api/v1/users/me", { status: 200, json: { ...saeonHeroUser(), employee_org_unit_id: "00000000-0000-4000-8210-000000000001" } });
  await mockRoute(page, "get", "/api/v1/me/authz", { status: 200, json: authz });
  await mockRoute(page, "get", "/api/v1/access/me", {
    status: 200,
    json: saeonTeamAccess({ concurrent: true, tenantWide: false, canManage: true }),
  });
  await mockRoute(page, "get", "/api/v1/employees", (req) => {
    const query = new URL(req.url()).searchParams;
    const items = query.get("workplace_id") === ulsanId ? scope2Employees : scope1Employees;
    return { status: 200, json: { ...allEmployees, items, total: items.length, next_cursor: null } };
  });
  await mockRoute(page, "get", "/api/v1/employees/facets", (req) => {
    const query = new URL(req.url()).searchParams;
    const isScope2 = query.get("workplace_id") === ulsanId;
    const base = saeonTeamFacets();
    return {
      status: 200,
      json: {
        ...base,
        total: query.has("contract_ending_on_or_after") ? (isScope2 ? 0 : 1) : 2,
        status: [
          { value: "ACTIVE", count: 2 },
          { value: "ON_LEAVE", count: 0 },
        ],
        review: { ...base.review, contract_ending_before: isScope2 ? 0 : 1 },
      },
    };
  });
  await mockRoute(page, "get", "/api/v2/leave/requests", { status: 200, json: { items: scope1Leave, next_cursor: null } });

  try {
    await page.goto("/team");
    await page.getByRole("button", { name: t("team.view.concurrent"), exact: true }).click();
    await page.getByLabel(t("team.concurrent.pick"), { exact: true }).selectOption(ulsanId);
    await expect(page.getByText(scope2Employees[0]!.name, { exact: true }).first()).toBeVisible();
    const stats = page.locator(`dl[aria-label="${t("team.stats.label")}"]`);
    await expect(stats).toContainText(`${t("team.stats.attention")}0`);
    await expect(page.getByText(t("team.notes.leaveOnly", { leaveCount: 1 }))).toHaveCount(0);
    expect(fixture.unexpected).toEqual([]);
  } finally {
    fixture.release();
  }
});

test("the team can read the next page of pending leave and update the attention total", async ({ page }) => {
  const { fixture, empPage } = await setupSaeonTeam(page, { theme: "light", tenantWide: true });
  const leave = saeonTeamLeaveQueue(empPage.items).items[0]!;
  const cursor = leave.id;
  let requested = false;
  await mockRoute(page, "get", "/api/v2/leave/requests", req => {
    if (new URL(req.url()).searchParams.get("cursor") === cursor) {
      requested = true;
      return { status: 200, json: { items: [{ ...leave, id: "00000000-0000-4000-8120-000000000099", subject_employee_id: empPage.items[1]!.id }], next_cursor: null } };
    }
    return { status: 200, json: { items: [leave], next_cursor: cursor } };
  });
  try {
    await page.goto("/team");
    const stats = page.getByLabel(t("team.stats.label"));
    await expect(stats).toContainText(`${t("team.stats.attention")}≥ 1`);
    await page.getByRole("button", { name: t("team.leave.more") }).click();
    expect(requested).toBe(true);
    await expect(stats).toContainText(`${t("team.stats.attention")}2`);
    await expect(page.getByText(t("team.notes.leaveOnly", { leaveCount: 2 }))).toBeVisible();
  } finally {
    fixture.release();
  }
});
