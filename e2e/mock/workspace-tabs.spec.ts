// SPDX-License-Identifier: LicenseRef-Proprietary
import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { EXPERIENCE_KEY } from "../../apps/web/src/lib/prefs";
import { expectAxe, fits } from "../a11y";
import { id } from "./fixtures";
import { setupConsoleSaeonPeople } from "./people-saeon";
import { mockRoute } from "./route";
import { SAEON_HERO_ID, saeonAdminUser, saeonApprovalOrgChange, saeonUniverse } from "./saeon";

const SHOTS_DIR = process.env.STRUCT_SHOTS;

test.beforeAll(() => loadCatalog("ko"));

for (const width of [1440, 390] as const) {
  for (const theme of ["light", "dark"] as const) {
    test(`WorkspaceTabs renders distinct sub-route and record titles without duplicates at ${width}px ${theme}`, async ({
      page,
    }) => {
      if (SHOTS_DIR) mkdirSync(SHOTS_DIR, { recursive: true });
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });

      const exitId = id(7000);
      const exitPersonName = saeonUniverse.rosterWindow[1]!.name;
      const heroPairLabel = t("shellRoutes.pair", {
        primary: saeonUniverse.hero.name,
        secondary: saeonUniverse.hero.employeeNumber,
      });
      const exitTabLabel = t("shellRoutes.exitCase", { name: exitPersonName });
      const orgChange = saeonApprovalOrgChange();
      const admin = saeonAdminUser();
      const principalKey = `console.tabs.${JSON.stringify(["00000000-0000-4000-8000-000000000002", admin.id])}`;
      const seededTabs = [
        { id: "pinned-home", href: "/", label: t("shell.link.home"), pinned: true },
        { id: "tab-roster", href: "/people", label: t("shellRoutes.peopleRoster") },
        { id: "tab-hero", href: `/people/${SAEON_HERO_ID}`, label: heroPairLabel },
        { id: "tab-exits", href: "/people/exits", label: t("shellRoutes.peopleExits") },
        { id: "tab-exit-case", href: `/people/exits/${exitId}`, label: exitTabLabel },
        { id: "tab-certs", href: "/people/certificates", label: t("shellRoutes.peopleCertificates") },
        { id: "tab-grid", href: "/people/grid", label: t("shellRoutes.peopleGrid") },
        { id: "tab-org-change", href: `/org/changes/${orgChange.id}`, label: t("shellRoutes.orgChange", { code: orgChange.code }) },
      ];

      await page.addInitScript(
        ({ key, value }) => {
          localStorage.setItem(key, value);
        },
        { key: principalKey, value: JSON.stringify(seededTabs) },
      );

      const fixture = await setupConsoleSaeonPeople(page, { theme });
      await mockRoute(page, "get", "/api/v1/hr/exit-cases/{id}", {
        status: 200,
        json: {
          id: exitId,
          employee_id: id(7001),
          employee_name: exitPersonName,
          employee_number: "10422",
          company: saeonUniverse.entities[0]!.name,
          status: "HR_CONFIRMED",
          effective_exit_date: "2026-11-30",
          site_manager_note: "RESIGNATION",
          involuntary: false,
          notice_required: false,
          dismissal_notice: null,
          protected_periods: [],
          reported_by: id(1),
          reported_by_name: saeonUniverse.adminActor.name,
          reported_at: "2026-11-10T09:00:00Z",
          hr_confirmed_by_name: saeonUniverse.adminActor.name,
          hq_confirmed_by_name: null,
          approval_submitted_by_name: null,
          closed_by_name: null,
          exit_lifecycle_event_id: null,
          exit_event_state: "SCHEDULED",
          next_actions: [],
        },
      });
      await page.route(
        url => url.pathname === `/api/v1/lifecycle-cases/${exitId}`,
        route =>
          route.fulfill({
            status: 200,
            json: {
              id: exitId,
              employee_id: id(7001),
              kind: "EXIT",
              state: "OPEN",
              trigger_id: null,
              effective_date: "2026-11-30",
              linked_case_id: null,
              cancellation_reason: null,
              version: 1,
              items: [],
            },
          }),
      );
      await mockRoute(page, "get", "/api/v1/org-changes/{id}", { status: 200, json: orgChange });

      try {
        await page.goto(`/people/${SAEON_HERO_ID}?tab=events`);
        await expect(page.getByRole("heading", { level: 1 })).toContainText(saeonUniverse.hero.name);

        if (width === 1440) {
          const tabsNav = page.getByRole("navigation", { name: t("shell.tabs.label"), exact: true });
          await expect(tabsNav).toBeVisible();

          const tabLinks = tabsNav.locator("[data-workspace-tab]");
          const labels = (await tabLinks.allInnerTexts()).map(text => text.trim());
          expect(labels).toContain(t("shell.link.home"));
          expect(labels).toContain(t("shellRoutes.peopleRoster"));
          expect(labels).toContain(heroPairLabel);
          expect(labels).toContain(t("shellRoutes.peopleExits"));
          expect(labels).toContain(exitTabLabel);
          expect(labels).toContain(t("shellRoutes.peopleCertificates"));
          expect(labels).toContain(t("shellRoutes.peopleGrid"));
          expect(labels).not.toContain(t("shell.link.people"));
          expect(new Set(labels).size).toBe(labels.length);

          await page.goto("/people/exits");
          await expect(tabsNav.locator('[aria-current="page"]')).toContainText(t("shellRoutes.peopleExits"));
          const afterExitsLabels = (await tabLinks.allInnerTexts()).map(text => text.trim());
          expect(afterExitsLabels.filter(l => l === t("shellRoutes.peopleExits"))).toHaveLength(1);

          await page.goto(`/people/exits/${exitId}`);
          await expect(tabsNav.locator('[aria-current="page"]')).toContainText(exitTabLabel);
        }

        if (SHOTS_DIR) {
          await page.screenshot({ path: path.join(SHOTS_DIR, `workspace-tabs--${width}-${theme}.png`) });
        }

        await fits(page, `WorkspaceTabs ${width} ${theme}`);
        await expectAxe(page, `WorkspaceTabs ${width} ${theme}`);
        expect(fixture.unexpected).toEqual([]);
      } finally {
        fixture.release();
      }
    });
  }
}

test("WorkspaceTabs assigns distinct labels for /people/certificates, /people/grid, and /org?tab=entities in desktop Chrome", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const fixture = await setupConsoleSaeonPeople(page, { theme: "light" });
  try {
    await page.addInitScript(
      ({ expKey }) => {
        localStorage.setItem(expKey, "console");
      },
      { expKey: EXPERIENCE_KEY },
    );

    const tabsNav = page.getByRole("navigation", { name: t("shell.tabs.label"), exact: true });

    await page.goto("/people/certificates");
    await expect(tabsNav.locator('[aria-current="page"]')).toContainText(t("shellRoutes.peopleCertificates"));

    await page.goto("/people/grid");
    await expect(tabsNav.locator('[aria-current="page"]')).toContainText(t("shellRoutes.peopleGrid"));

    await page.goto("/org?tab=entities");
    await expect(tabsNav.locator('[aria-current="page"]')).toContainText(t("shellRoutes.orgEntities"));

    await page.goto("/org");
    await expect(tabsNav.locator('[aria-current="page"]')).toContainText(t("shellRoutes.orgChart"));

    expect(fixture.unexpected).toEqual([]);
  } finally {
    fixture.release();
  }
});
