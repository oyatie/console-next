// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, type Page } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { expectAxe, fits } from "../a11y";
import { test } from "../locale-fixture";
import { shot, withFullPage } from "../shots";
import { failure } from "./fixtures";
import { setupConsoleSaeonPeople } from "./people-saeon";
import { mockRoute } from "./route";
import { SAEON_HERO_ID, saeonUniverse } from "./saeon";

test.beforeAll(() => loadCatalog("ko"));

const capture = async (page: Page, width: 1440 | 390, name: string, theme: "light" | "dark") => {
  const dir = process.env.STRUCT_SHOTS;
  if (!dir) return;
  if ((await page.locator('[role="dialog"]').count()) > 0) {
    await page.screenshot({ path: `${dir}/${name}--${width}-${theme}.png`, fullPage: false });
    return;
  }
  await withFullPage(page, () => shot(page, `${name}--${width}-${theme}`));
};

for (const width of [1440, 390] as const) {
  for (const theme of ["light", "dark"] as const) {
    test(`Console people tabs, registration, bulk edit, and grid (${width}px ${theme})`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      const fixture = await setupConsoleSaeonPeople(page, { theme, experience: "console", canManage: true });

      const batchFactCalls: string[] = [];
      const singleFactCalls: string[] = [];
      const detailCalls: string[] = [];
      const idsBatchCalls: string[] = [];
      const countsCalls: string[] = [];

      page.on("request", req => {
        const u = new URL(req.url());
        if (req.method() === "POST" && u.pathname === "/api/v1/employees/register-facts/query") {
          batchFactCalls.push(u.pathname);
        } else if (req.method() === "GET" && /^\/api\/v1\/employees\/[^/]+\/register-facts$/.test(u.pathname)) {
          singleFactCalls.push(u.pathname);
        } else if (req.method() === "GET" && /^\/api\/v1\/employees\/[^/]+$/.test(u.pathname) && !u.pathname.endsWith("/facets") && !u.pathname.endsWith("/voided")) {
          detailCalls.push(u.pathname);
        } else if (req.method() === "GET" && u.pathname === "/api/v1/employees" && u.searchParams.has("ids")) {
          idsBatchCalls.push(u.search);
        } else if (req.method() === "GET" && u.pathname === "/api/v1/hr/exit-cases/counts") {
          countsCalls.push(u.search);
        }
      });

      await mockRoute(page, "post", "/api/v1/employees", {
        status: 409,
        json: {
          error: {
            code: "duplicate_candidate",
            message: "duplicate candidate",
            operation_id: "00000000-0000-4000-8000-000000000098",
            refusals: [
              {
                employee_id: SAEON_HERO_ID,
                employee_number: saeonUniverse.hero.employeeNumber,
                name: saeonUniverse.hero.name,
                org_unit: `${saeonUniverse.entities[0]!.name} › ${saeonUniverse.entities[0]!.workplaces[0]!.name}`,
                hire_date: saeonUniverse.hero.hireDate,
                status: "ACTIVE",
                basis: "name_birth_date",
                remedy: null,
              },
            ],
          },
        } as never,
      });

      try {
        // 1. /people?tab=appointments: single ListRecord, PageTabs shared
        await page.goto("/people?tab=appointments");
        const main = page.getByRole("main");
        const nav = main.getByRole("navigation", { name: t("roster.head.title"), exact: true });
        await expect(nav).toBeVisible();
        await expect(page.locator('[data-pattern="list-record"]')).toHaveCount(1);
        await expect(main.getByText(t("bulk.page.empty.title"), { exact: true })).toBeVisible();
        await expect(main.getByRole("heading", { name: t("notice.title"), exact: true })).toBeVisible();
        await fits(page, `Console appointments ${width} ${theme}`);
        await expectAxe(page, `Console appointments ${width} ${theme}`);
        await capture(page, width, "people-appointments", theme);

        // 2. /people?tab=exits: uses exitCaseCountsQuery + APPROVAL_DRAFTED filter
        await page.goto("/people?tab=exits");
        await expect(page.locator('[data-pattern="list-record"]')).toHaveCount(1);
        await expect(main.getByRole("grid", { name: t("exit.list.title"), exact: true })).toBeVisible();
        if (width === 1440) {
          await expect(main.getByRole("button", { name: new RegExp(t("enum.exitCaseStatus.APPROVAL_DRAFTED")) })).toBeVisible();
        } else {
          const filterSelect = main.getByRole("combobox", { name: t("exit.list.chips") });
          await expect(filterSelect).toBeVisible();
          await expect(filterSelect.locator('option[value="APPROVAL_DRAFTED"]')).toHaveCount(1);
        }
        expect(countsCalls.length).toBeGreaterThanOrEqual(1);
        await fits(page, `Console exits tab ${width} ${theme}`);
        await expectAxe(page, `Console exits tab ${width} ${theme}`);
        await capture(page, width, "people-exits-tab", theme);

        // 3. /people/new: RegisterSheet + duplicate candidate without N+1 employeeQuery
        await page.goto("/people/new");
        const sheet = page.getByRole("dialog");
        await expect(sheet).toBeVisible();
        detailCalls.length = 0;
        await sheet.locator('input[name="name"]').fill(saeonUniverse.hero.name);
        await sheet.getByText(t("register.where.none"), { exact: true }).click();
        await sheet.getByRole("button", { name: new RegExp(`^${t("uiDate.preset.today")}`) }).click();
        await sheet.getByRole("button", { name: t("register.run.submit"), exact: true }).click();
        await expect(sheet.getByRole("columnheader", { name: new RegExp(saeonUniverse.hero.name) })).toBeVisible();
        expect(detailCalls).toEqual([]);
        await fits(page, `Console /people/new ${width} ${theme}`);
        await expectAxe(page, `Console /people/new ${width} ${theme}`);
        await capture(page, width, "people-new", theme);

        // 4. /people/run: P8 WizardPattern
        await page.goto("/people/run");
        await expect(page.locator('[data-pattern="wizard"]')).toHaveCount(1);
        await expect(main.getByRole("heading", { level: 1, name: t("register.run.title") })).toBeVisible();
        await fits(page, `Console /people/run ${width} ${theme}`);
        await expectAxe(page, `Console /people/run ${width} ${theme}`);
        await capture(page, width, "people-run", theme);

        // 5. Select 2 rows on /people roster, then navigate via client actions to /people/renew, /people/grid, /people/bulk
        await page.goto("/people");
        const pickTwo = async () => {
          const rows = main.locator('[role="row"][data-row-id]');
          await expect(rows.nth(1)).toBeVisible();
          await rows.nth(0).locator("label", { has: page.getByRole("checkbox") }).click();
          await rows.nth(1).locator("label", { has: page.getByRole("checkbox") }).click();
        };
        await pickTwo();

        // /people/renew
        await main.getByRole("button", { name: t("renew.open", { count: 2 }), exact: true }).click();
        await expect(page).toHaveURL(/\/people\/renew/);
        await expect(page.locator('[data-pattern="wizard"]')).toHaveCount(1);
        // One named region per table: the focusable scroller carries the name, its pane does not repeat it.
        await expect(main.getByRole("region", { name: t("renew.crumb"), exact: true })).toHaveCount(1);
        await fits(page, `Console /people/renew ${width} ${theme}`);
        await expectAxe(page, `Console /people/renew ${width} ${theme}`);
        await capture(page, width, "people-renew", theme);

        // /people/grid (via back-to-roster selection to keep bulkSelection populated)
        await page.goto("/people");
        await pickTwo();
        batchFactCalls.length = 0;
        singleFactCalls.length = 0;
        await main.getByRole("button", { name: t("bulkGrid.open", { count: 2 }), exact: true }).click();
        await expect(page).toHaveURL(/\/people\/grid/);
        await expect(page.locator('[data-pattern="wizard"]')).toHaveCount(1);
        await expect.poll(() => batchFactCalls.length).toBeGreaterThanOrEqual(1);
        expect(singleFactCalls).toEqual([]);
        await fits(page, `Console /people/grid ${width} ${theme}`);
        await expectAxe(page, `Console /people/grid ${width} ${theme}`);
        await capture(page, width, "people-grid", theme);

        // /people/bulk (uses employees?ids=... batching, zero N+1/scan)
        await page.goto("/people");
        await pickTwo();
        idsBatchCalls.length = 0;
        await main.getByRole("button", { name: t("people.bulk.open", { count: 2 }), exact: true }).click();
        await expect(page).toHaveURL(/tab=appointments/);
        await expect.poll(() => idsBatchCalls.length).toBeGreaterThanOrEqual(1);
        await expect(main.getByRole("heading", { name: t("bulk.page.where"), exact: true })).toBeVisible();
        await expect(main.getByRole("region", { name: t("bulk.page.people", { n: 2 }), exact: true })).toHaveCount(1);
        await fits(page, `Console /people/bulk populated ${width} ${theme}`);
        await expectAxe(page, `Console /people/bulk populated ${width} ${theme}`);
        await capture(page, width, "people-bulk", theme);
        await page.goto("/people/bulk");
        await expect(main.getByText(t("bulk.page.empty.title"), { exact: true })).toBeVisible();
        await fits(page, `Console /people/bulk ${width} ${theme}`);
        await expectAxe(page, `Console /people/bulk ${width} ${theme}`);

        expect(fixture.unexpected).toEqual([]);
      } finally {
        await page.close();
        fixture.release();
      }
    });
  }
}

test("Console handles 403 refusal on tab=exits and preserves baseline on /people/run & /people/bulk", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const refused = await setupConsoleSaeonPeople(page, { experience: "console", canManage: false });
  await mockRoute(page, "get", "/api/v1/hr/exit-cases", { status: 403, json: failure("forbidden") });
  await mockRoute(page, "get", "/api/v1/hr/exit-cases/counts", { status: 403, json: failure("forbidden") });
  try {
    await page.goto("/people?tab=exits");
    const main = page.getByRole("main");
    await expect(main.getByRole("navigation", { name: t("roster.head.title"), exact: true })).toBeVisible();
    await expect(main.getByRole("heading", { name: t("common.denied.title.plain"), exact: true })).toBeVisible();
    expect(refused.unexpected).toEqual([]);
  } finally {
    refused.release();
  }

  await page.goto("about:blank");
  await page.unrouteAll({ behavior: "ignoreErrors" });
  const baseline = await setupConsoleSaeonPeople(page, { experience: "baseline", canManage: true });
  try {
    await page.goto("/people/run");
    await expect(page.locator("[data-pattern]")).toHaveCount(0);
    await expect(page.getByRole("main").getByRole("heading", { level: 1 })).toBeVisible();
    await page.goto("/people/bulk");
    await expect(page.locator("[data-pattern]")).toHaveCount(0);
    expect(baseline.unexpected).toEqual([]);
  } finally {
    await page.close();
    baseline.release();
  }
});
