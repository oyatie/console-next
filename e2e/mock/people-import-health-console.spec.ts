// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, type Page } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { expectAxe, fits } from "../a11y";
import { test } from "../locale-fixture";
import { shot, withFullPage } from "../shots";
import { failure } from "./fixtures";
import { setupConsoleSaeonPeople } from "./people-saeon";
import { mockRoute } from "./route";
import { saeonUniverse } from "./saeon";

test.beforeAll(() => loadCatalog("ko"));

const capture = async (page: Page, width: 1440 | 390, name: string, theme: "light" | "dark") => {
  const dir = process.env.STRUCT_SHOTS;
  if (!dir) return;
  await withFullPage(page, () => shot(page, `${name}--${width}-${theme}`));
};

for (const width of [1440, 390] as const) {
  for (const theme of ["light", "dark"] as const) {
    test(`Console import, unplaced & data-health (${width}px ${theme})`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      const fixture = await setupConsoleSaeonPeople(page, {
        theme,
        experience: "console",
        canManage: true,
        unplacedPopulated: true,
      });

      try {
        const main = page.getByRole("main");

        // 1. /people/import -> upload -> preview (restricted col check) -> dryrun triage capture
        await page.goto("/people/import");
        await expect(page.locator('[data-pattern="wizard"]')).toHaveCount(1);
        await expect(page.getByRole("link", { name: t("import.aside.healthLink") })).toBeVisible();

        const chooser = page.waitForEvent("filechooser");
        await page.getByRole("button", { name: t("uiFileDrop.pick"), exact: true }).click();
        await (await chooser).setFiles({
          name: "saeon-2026-hire-batch.csv",
          mimeType: "text/csv",
          buffer: Buffer.from("employee_number,name,hire_date,BaseSalary\n10701,Sample,2026-12-01,4000000\n"),
        });
        await page.getByRole("button", { name: t("import.preview"), exact: true }).click();
        await expect(page.locator("#import-sheets")).toBeVisible();

        // Open sheet editor and verify restricted BaseSalary option gating
        const sheetSection = page.getByRole("region", { name: t("importSheet.sheet", { name: saeonUniverse.entities[0]!.name }), exact: true });
        await sheetSection.getByRole("button", { name: t("importSheet.remap", { name: saeonUniverse.entities[0]!.name }) }).click();
        const restrictedSelect = sheetSection.getByRole("combobox", {
          name: t("importSheet.map.target", { sheet: saeonUniverse.entities[0]!.name, column: "G", label: "BaseSalary" }),
        });
        await expect(restrictedSelect.getByRole("option")).toHaveText([t("importSheet.map.notImported")]);
        await expect(sheetSection.getByText(t("importSheet.restricted.none"))).toBeVisible();

        // Run dry-run and verify triage + inspector + capture
        await page.getByRole("button", { name: t("import.dryRun"), exact: true }).click();
        await expect(page.locator('section[aria-labelledby="import-dry"]')).toBeVisible();
        await expect(page.getByRole("button", { name: new RegExp(t("import.triage.blocker")) })).toBeVisible();
        await expect(page.getByText(t("import.hint.invalid_date"))).toBeVisible();

        // Verify all 4 import_exclude reason radio chips render under ReviewResolve
        const resolveSection = page.locator('section[aria-labelledby="import-resolve"]');
        for (const item of saeonUniverse.reasonCodes.import_exclude) {
          await expect(resolveSection.getByRole("radio", { name: item.labelKo })).toBeVisible();
        }

        // Click PRE_HIRE row to inspect derived sex hint + badge without leaking row 5 invalid_date hint
        const preHireRow = page.getByRole("grid", { name: t("import.rows.title") }).getByRole("row").filter({ hasText: saeonUniverse.statusSamples.preHire.name }).first();
        await preHireRow.click();
        const rowDetailRegion = page.getByRole("region", {
          name: t("import.rows.detail", { sheet: saeonUniverse.entities[0]!.name, row: 2, name: saeonUniverse.statusSamples.preHire.name }),
        });
        await expect(rowDetailRegion.getByText(t("import.rows.preHireBadge"))).toBeVisible();
        await expect(rowDetailRegion.getByText(t("import.rows.sexDerived", { sex: t("import.sex.MALE") }))).toBeVisible();
        await expect(rowDetailRegion).not.toContainText(t("import.hint.invalid_date"));
        await expect(page.getByText(t("import.hint.invalid_date"))).toBeVisible();

        // Click blocker triage filter then back to all for clean screenshot
        await page.getByRole("button", { name: t("import.triage.blocker"), exact: true }).click();
        await page.getByRole("button", { name: t("import.triage.all"), exact: true }).click();

        await fits(page, `Console /people/import ${width} ${theme}`);
        await expectAxe(page, `Console /people/import ${width} ${theme}`);
        await capture(page, width, "people-import", theme);

        // 2. /people/unplaced (CompanyMappings below panes, zero native <select>, DisabledReason on blocked CTA)
        await page.goto("/people/unplaced");
        await expect(page.getByRole("heading", { level: 1, name: t("unplaced.title") })).toBeVisible();
        await expect(page.getByText("10506")).toBeVisible();
        await page.getByRole("button", { name: new RegExp(t("unplaced.noValue")) }).click();
        await expect(page.getByText("10433")).toBeVisible();
        await expect(page.getByText(`${saeonUniverse.entities[0]!.name} (2025)`)).toBeVisible();

        // Verify CompanyMappings is visually below the 3-pane workspace
        const tabsBox = await page.getByRole("group", { name: t("unplaced.tabs") }).boundingBox();
        const mappingsBox = await page.getByRole("heading", { name: t("setup.names.title") }).boundingBox();
        expect(tabsBox).not.toBeNull();
        expect(mappingsBox).not.toBeNull();
        expect(mappingsBox!.y).toBeGreaterThan(tabsBox!.y + tabsBox!.height);
        await expect(page.locator("main select:not([tabindex='-1'])")).toHaveCount(0);
        await expect(
          main.getByRole("region", { name: t("setup.names.title") }).getByRole("button", { name: new RegExp(t("placement.entity")) }),
        ).toBeVisible();

        await fits(page, `Console /people/unplaced ${width} ${theme}`);
        await expectAxe(page, `Console /people/unplaced ${width} ${theme}`);
        await capture(page, width, "people-unplaced", theme);

        // 3. /people/data-health (analytical list view)
        await page.goto("/people/data-health");
        await expect(page.locator('[data-pattern="list-record"]')).toHaveCount(1);
        await expect(main.getByRole("heading", { level: 1, name: t("dataHealth.title") })).toBeVisible();
        await expect(main.getByRole("heading", { level: 2, name: t("dataHealth.summary.title") })).toBeVisible();
        await expect(main.getByRole("heading", { level: 2, name: t("dataHealth.worklist.title") })).toBeVisible();

        await fits(page, `Console /people/data-health ${width} ${theme}`);
        await expectAxe(page, `Console /people/data-health ${width} ${theme}`);
        await capture(page, width, "people-data-health", theme);

        expect(fixture.unexpected).toEqual([]);
      } finally {
        fixture.release();
      }
    });
  }
}

test("Console import, unplaced & data-health interactive flows, view-only gating, error states, and baseline preservation", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });

  // 1. Roster consoleTools link to /people/data-health + KPI/side-pane interactivity
  const admin = await setupConsoleSaeonPeople(page, { experience: "console", canManage: true, unplacedPopulated: true });
  try {
    await page.goto("/people");
    const dhLink = page.getByRole("link", { name: t("roster.head.dataHealth") });
    await expect(dhLink).toBeVisible();
    await dhLink.click();
    await expect(page).toHaveURL(/\/people\/data-health$/);

    await page.getByRole("button", { name: new RegExp(t("dataHealth.stat.register")) }).click();
    const worklist = page.getByRole("grid", { name: t("dataHealth.worklist.title") });
    await expect(worklist).toBeVisible();
    await worklist.getByRole("row").nth(1).click();
    await expect(page.getByRole("complementary", { name: t("dataHealth.pane.label") })).toBeVisible();
    expect(admin.unexpected).toEqual([]);
  } finally {
    admin.release();
  }

  // 2. View-only permission gating on /people/data-health (must NOT call hr_basic:edit endpoints)
  await page.goto("about:blank");
  await page.unrouteAll({ behavior: "ignoreErrors" });
  const gatedCalls: string[] = [];
  page.on("request", req => {
    const p = new URL(req.url()).pathname;
    if (
      p === "/api/v1/employees/register-facts/query" ||
      p === "/api/v1/employees/import/unplaced" ||
      p === "/api/v1/employee-import-runs"
    ) {
      gatedCalls.push(p);
    }
  });
  const viewer = await setupConsoleSaeonPeople(page, { experience: "console", canManage: false });
  try {
    await page.goto("/people/data-health");
    await expect(page.getByText(t("dataHealth.limitedNotice"))).toBeVisible();
    expect(gatedCalls).toEqual([]);
    expect(viewer.unexpected).toEqual([]);
  } finally {
    viewer.release();
  }

  // 3. Data health empty & failed states
  await page.goto("about:blank");
  await page.unrouteAll({ behavior: "ignoreErrors" });
  const emptyFix = await setupConsoleSaeonPeople(page, { experience: "console", canManage: true });
  await mockRoute(page, "get", "/api/v1/employees", { status: 200, json: { items: [], total: 0, limit: 200, offset: 0, next_cursor: null } });
  await mockRoute(page, "get", "/api/v1/employees/facets", {
    status: 200,
    json: {
      total: 0,
      status: [],
      employment_type: [],
      legal_entity: [],
      workplace: [],
      review: { department_missing: 0, identity_review_required: 0, register_review_required: 0, home_branch_review_required: 0, lifecycle_apply_failed: 0, contract_ended: 0, contract_ending_before: 0 },
    },
  });
  try {
    await page.goto("/people/data-health");
    await expect(page.getByText(t("dataHealth.worklist.emptyTitle"))).toBeVisible();
  } finally {
    emptyFix.release();
  }

  await page.goto("about:blank");
  await page.unrouteAll({ behavior: "ignoreErrors" });
  const refusedFix = await setupConsoleSaeonPeople(page, { experience: "console", canManage: false });
  await mockRoute(page, "get", "/api/v1/employees", { status: 403, json: failure("forbidden") });
  await mockRoute(page, "get", "/api/v1/employees/facets", { status: 403, json: failure("forbidden") });
  try {
    await page.goto("/people/data-health");
    await expect(page.getByRole("main").getByRole("heading", { name: t("common.denied.title.plain"), exact: true })).toBeVisible();
  } finally {
    refusedFix.release();
  }

  // 4. Baseline fallback preservation for /people/import, /people/unplaced, /people/data-health
  await page.goto("about:blank");
  await page.unrouteAll({ behavior: "ignoreErrors" });
  const baseline = await setupConsoleSaeonPeople(page, { experience: "baseline", canManage: true, unplacedPopulated: true });
  try {
    for (const url of ["/people/import", "/people/unplaced", "/people/data-health"]) {
      await page.goto(url);
      await expect(page.locator("[data-pattern]")).toHaveCount(0);
    }
    expect(baseline.unexpected).toEqual([]);
  } finally {
    await page.close();
    baseline.release();
  }
});
