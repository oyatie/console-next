// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test, type Page } from "@playwright/test";
import type { paths } from "@console/api/schema";
import { loadCatalog, t } from "@console/i18n";
import { EXPERIENCE_KEY } from "../../apps/web/src/lib/prefs";
import { expectAxe, fits } from "../a11y";
import { shot, withFullPage } from "../shots";
import { screens } from "../states/registry";
import { screenAccess } from "./fixtures";
import { mockRoute } from "./route";
import {
  saeonAdminUser,
  saeonApprovalOrgChange,
  saeonEmployeeFacets,
  saeonOrgStructure,
  saeonUniverse,
  saeonWorklistInbox,
} from "./saeon";
import { mockScreen } from "./screen";

test.beforeAll(() => loadCatalog("ko"));

async function setupConsoleSaeonWorklist(page: Page) {
  const fixture = await mockScreen(page, screens[0], "populated");
  const inbox = saeonWorklistInbox();
  const orgDetail = saeonApprovalOrgChange();
  const structure = saeonOrgStructure();
  const orgUnits: paths["/api/v1/org-units"]["get"]["responses"]["200"]["content"]["application/json"]["items"] =
    structure.entities.flatMap(entity =>
      (entity.children ?? []).flatMap(site =>
        (site.children ?? []).map(dept => ({
          id: dept.id,
          name: dept.name,
          kind: dept.kind === "SITE" ? ("SITE" as const) : ("DEPARTMENT" as const),
          parentId: site.id,
          status: "ACTIVE" as const,
          effectiveFrom: "2020-01-01",
          headcount: dept.headcount,
          updatedAt: "2026-11-10T09:00:00+09:00",
        })),
      ),
    );
  const team2 = saeonUniverse.entities[0]!.workplaces[1]!.departments[2]!.split(" › ").at(-1)!;
  const team3 = saeonUniverse.entities[0]!.workplaces[1]!.departments[3]!.split(" › ").at(-1)!;
  orgUnits.push(
    {
      id: "00000000-0000-4000-8400-000000000002",
      name: team2,
      kind: "DEPARTMENT",
      parentId: structure.entities[0]!.children![0]!.id,
      status: "ACTIVE",
      effectiveFrom: "2020-01-01",
      headcount: 14,
      updatedAt: "2026-11-10T09:00:00+09:00",
    },
    {
      id: "00000000-0000-4000-8400-000000000003",
      name: team3,
      kind: "DEPARTMENT",
      parentId: structure.entities[0]!.children![0]!.id,
      status: "ACTIVE",
      effectiveFrom: "2020-01-01",
      headcount: 8,
      updatedAt: "2026-11-10T09:00:00+09:00",
    },
  );

  const orgAccess = screenAccess("/org");
  const peopleAccess = screenAccess("/people");
  await page.addInitScript(key => localStorage.setItem(key, "console"), EXPERIENCE_KEY);
  await mockRoute(page, "get", "/api/v1/users/me", { status: 200, json: saeonAdminUser() });
  await mockRoute(page, "get", "/api/v1/access/me", {
    status: 200,
    json: { ...orgAccess, entries: [...orgAccess.entries, ...peopleAccess.entries] },
  });
  await mockRoute(page, "get", "/api/v1/employees/facets", { status: 200, json: saeonEmployeeFacets() });
  await mockRoute(page, "get", "/api/v1/org-structure", { status: 200, json: structure });
  await mockRoute(page, "get", "/api/v1/org-units", { status: 200, json: { items: orgUnits } });
  await mockRoute(page, "get", "/api/v1/org-changes/{id}", { status: 200, json: orgDetail });
  await mockRoute(page, "get", "/api/v1/me/action-inbox", request => {
    const query = new URL(request.url()).searchParams;
    const attention = query.get("attention");
    const items =
      attention === "approvals"
        ? inbox.items.filter(item => item.kind === "org_change_approve")
        : attention === "today"
          ? inbox.items.filter(item => item.days_remaining === 0)
          : attention === "overdue"
            ? inbox.items.filter(item => (item.days_remaining ?? 0) < 0)
            : inbox.items;
    return { status: 200, json: { ...inbox, items } };
  });
  return fixture;
}

for (const width of [1440, 390]) {
  for (const theme of ["light", "dark"]) {
    test(`Console Home renders Worklist (P1) with Saeon worklist, schedule, lower bands, and decision pane at ${width}px ${theme}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript(value => localStorage.setItem("console.theme", value), theme);
      const fixture = await setupConsoleSaeonWorklist(page);
      try {
        await page.goto(width === 1440 ? "/?sel=OC-2026-0418" : "/");
        const worklist = page.locator('[data-pattern="worklist"]');
        const queueTable = worklist.getByRole("grid", { name: t("home.inbox.title"), exact: true });
        await expect(worklist).toBeVisible();
        await expect(page.locator("[data-deadline-strip]")).toBeVisible();
        await expect(queueTable.locator("tbody tr[data-id]")).toHaveCount(10);
        await expect(page.getByRole("meter")).toHaveCount(5);

        if (width === 1440) {
          await expect(page.locator('aside[data-pane="record"]')).toBeVisible();
          await expect(page.locator("[data-decision-pane]")).toBeVisible();
        }
        await withFullPage(page, () => shot(page, `home--${width}-${theme}`));

        await fits(page, `Console Home ${width} ${theme}`);
        await expectAxe(page, `Console Home ${width} ${theme}`);

        if (width === 390) {
          await queueTable.locator('tbody tr[data-id="OC-2026-0418"]').click();
          await expect(page.locator('aside[data-pane="record"]')).toBeVisible();
          await expect(page.locator("[data-decision-pane]")).toBeVisible();
          await fits(page, `Console Home detail ${width} ${theme}`);
          await expectAxe(page, `Console Home detail ${width} ${theme}`);
        }
        expect(fixture.unexpected).toEqual([]);
      } finally {
        fixture.release();
      }
    });
  }
}

test("Console Home filters, column chooser, and /inbox tabs work end-to-end", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const fixture = await setupConsoleSaeonWorklist(page);
  try {
    await page.goto("/");
    const worklist = page.locator('[data-pattern="worklist"]');
    const queueTable = worklist.getByRole("grid", { name: t("home.inbox.title"), exact: true });
    await expect(queueTable.locator("tbody tr[data-id]")).toHaveCount(10);

    await worklist.getByRole("checkbox", { name: t("home.worklist.statutoryOnly"), exact: true }).check();
    await expect(queueTable.locator("tbody tr[data-id]")).toHaveCount(3);
    await worklist.getByRole("checkbox", { name: t("home.worklist.statutoryOnly"), exact: true }).uncheck();
    await expect(queueTable.locator("tbody tr[data-id]")).toHaveCount(10);

    await worklist.locator("[data-list-find] input").fill("OC-2026-0418");
    await expect(queueTable.locator("tbody tr[data-id]")).toHaveCount(1);
    await worklist.locator("[data-list-find] input").fill("");
    await expect(queueTable.locator("tbody tr[data-id]")).toHaveCount(10);

    await worklist.getByRole("button", { name: t("home.worklist.columns"), exact: true }).click();
    const colDialog = page.getByRole("dialog", { name: t("home.worklist.columns"), exact: true });
    await expect(colDialog).toBeVisible();
    await colDialog.getByRole("checkbox", { name: t("home.worklist.col.statutory"), exact: true }).uncheck();
    await colDialog.getByRole("button", { name: t("composer.dismiss"), exact: true }).click();
    await expect(worklist.getByRole("columnheader", { name: t("home.worklist.col.statutory"), exact: true })).toHaveCount(0);

    await page.goto("/inbox?sel=OC-2026-0418");
    await expect(page.locator('[data-pattern="worklist"]')).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: t("home.inbox.title"), exact: true })).toBeVisible();
    await expect(page.locator('aside[data-pane="record"]')).toBeVisible();
    await fits(page, "Console Inbox 1440");
    await expectAxe(page, "Console Inbox 1440");
    expect(fixture.unexpected).toEqual([]);
  } finally {
    fixture.release();
  }
});
