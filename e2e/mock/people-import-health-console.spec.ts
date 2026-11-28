// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, type Page } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { expectAxe, fits } from "../a11y";
import { rrn } from "../helpers/import-layouts";
import { test } from "../locale-fixture";
import { shot, withFullPage } from "../shots";
import { failure } from "./fixtures";
import { setupConsoleSaeonPeople } from "./people-saeon";
import { mockRoute } from "./route";
import { saeonPeopleDataHealth, saeonUniverse } from "./saeon";

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

        // 1. /people/import -> upload -> preview (restricted col + id_type check) -> dryrun capture
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

        // Open sheet editor: BaseSalary stays restricted while id_type stays selectable
        const sheetSection = page.getByRole("region", { name: t("importSheet.sheet", { name: saeonUniverse.entities[0]!.name }), exact: true });
        await sheetSection.getByRole("button", { name: t("importSheet.remap", { name: saeonUniverse.entities[0]!.name }) }).click();
        const restrictedSelect = sheetSection.getByRole("combobox", {
          name: t("importSheet.map.target", { sheet: saeonUniverse.entities[0]!.name, column: "G", label: "BaseSalary" }),
        });
        await expect(restrictedSelect.getByRole("option")).toHaveText([t("importSheet.map.notImported")]);
        await expect(sheetSection.getByText(t("importSheet.restricted.none"))).toBeVisible();
        const idTypeSelect = sheetSection.getByRole("combobox", {
          name: t("importSheet.map.target", { sheet: saeonUniverse.entities[0]!.name, column: "H", label: t("import.target.id_type") }),
        });
        await expect(idTypeSelect).toHaveValue("id_type");

        // Run dry-run: two_digit_year inline repair opens for Row 5
        await page.getByRole("button", { name: t("import.dryRun"), exact: true }).click();
        await expect(page.locator('section[aria-labelledby="import-dry"]')).toBeVisible();
        await expect(page.getByRole("button", { name: new RegExp(t("import.triage.blocker")) })).toBeVisible();
        await expect(page.getByText(t("importReview.hint.two_digit_year"))).toBeVisible();

        const resolveSection = page.locator('section[aria-labelledby="import-resolve"]');
        await expect(resolveSection.getByPlaceholder("YYYY-MM-DD")).toBeVisible();
        await expect(page.getByRole("grid", { name: t("import.rows.title") })).toContainText(t("enum.idType.DOMESTIC_RESIDENCE"));

        // Inspect PRE_HIRE NOT_ISSUED row (pre-hire badge + derived sex + PII_RECORD entry) without leaking Row 5 hint
        const preHireRow = page.getByRole("grid", { name: t("import.rows.title") }).getByRole("row").filter({ hasText: saeonUniverse.statusSamples.preHire.name }).first();
        await preHireRow.click();
        const rowDetailRegion = page.getByRole("region", {
          name: t("import.rows.detail", { sheet: saeonUniverse.entities[0]!.name, row: 2, name: saeonUniverse.statusSamples.preHire.name }),
        });
        await expect(rowDetailRegion.getByText(t("enum.idType.NOT_ISSUED"))).toBeVisible();
        await expect(rowDetailRegion.getByText(t("import.rows.preHireBadge"))).toBeVisible();
        await expect(rowDetailRegion.getByText(t("import.rows.sexDerived", { sex: t("import.sex.MALE") }))).toBeVisible();
        await expect(rowDetailRegion.getByLabel(new RegExp(t("importReview.identifier.rrn").replace(/[()]/g, "\\$&")))).toBeVisible();
        await expect(rowDetailRegion).not.toContainText(t("importReview.hint.two_digit_year"));

        // Re-select Row 5 blocker for clean inline repair capture alongside pre-hire and domestic-residence rows
        const row5 = page.getByRole("grid", { name: t("import.rows.title") }).getByRole("row").filter({ hasText: "26-11-01" }).first();
        if (await row5.count()) await row5.click();
        else await page.getByRole("grid", { name: t("import.rows.title") }).getByRole("row").nth(4).click();

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

        // 3. /people/data-health (single backend endpoint, zero raw PII)
        await page.goto("/people/data-health");
        await expect(page.locator('[data-pattern="list-record"]')).toHaveCount(1);
        await expect(main.getByRole("heading", { level: 1, name: t("dataHealth.title") })).toBeVisible();
        await expect(main.getByRole("heading", { level: 2, name: t("dataHealth.idSummary.title") })).toBeVisible();
        await expect(main.getByRole("heading", { level: 2, name: t("dataHealth.summary.title") })).toBeVisible();
        await expect(main.getByRole("heading", { level: 2, name: t("dataHealth.worklist.title") })).toBeVisible();
        await expect(main.getByText(t("dataHealth.latestImportOpen"))).toBeVisible();

        const worklistGrid = main.getByRole("grid", { name: t("dataHealth.worklist.title") });
        await expect(worklistGrid).toContainText(`#${saeonUniverse.statusSamples.preHire.employeeNumber}`);
        await expect(worklistGrid).not.toContainText(saeonUniverse.statusSamples.preHire.name);

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

test("Console import inline repair & step-up PII_RECORD, data-health drilldown, view-only gating, error states, and baseline preservation", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });

  // 1. Inline cell repair + PII_RECORD step-up on /people/import
  const importAdmin = await setupConsoleSaeonPeople(page, { experience: "console", canManage: true, unplacedPopulated: true });
  try {
    await page.goto("/people/import");
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: t("uiFileDrop.pick"), exact: true }).click();
    await (await chooser).setFiles({
      name: "saeon-2026-hire-batch.csv",
      mimeType: "text/csv",
      buffer: Buffer.from("employee_number,name,hire_date\n10701,Sample,2026-12-01\n"),
    });
    await page.getByRole("button", { name: t("import.preview"), exact: true }).click();
    await page.getByRole("button", { name: t("import.dryRun"), exact: true }).click();

    // 2-digit year fails with 422 two_digit_year, 4-digit YYYY-MM-DD repairs in-place and clears blocker without deadlocking Apply
    const resolveSection = page.locator('section[aria-labelledby="import-resolve"]');
    const dateInput = resolveSection.getByPlaceholder("YYYY-MM-DD");
    await dateInput.fill("26-11-01");
    await resolveSection.getByRole("button", { name: t("importReview.cells.save"), exact: true }).click();
    await expect(resolveSection.getByText(t("importReview.refusal.two_digit_year"))).toBeVisible();

    await dateInput.fill("2026-11-01");
    await resolveSection.getByRole("button", { name: t("importReview.cells.save"), exact: true }).click();
    await expect(page.getByText(t("importReview.hint.two_digit_year"))).toHaveCount(0);
    await expect(page.getByText(t("import.rerun.pending"))).toHaveCount(0);
    await expect(page.getByRole("button", { name: t("import.apply", { insert: 3, update: 2 }), exact: true })).not.toHaveAttribute("aria-disabled", "true");

    // Record F-4 DOMESTIC_RESIDENCE identifier on PRE_HIRE NOT_ISSUED row via PII_RECORD step-up
    const preHireRow = page.getByRole("grid", { name: t("import.rows.title") }).getByRole("row").filter({ hasText: saeonUniverse.statusSamples.preHire.name }).first();
    await preHireRow.click();
    const rowDetailRegion = page.getByRole("region", {
      name: t("import.rows.detail", { sheet: saeonUniverse.entities[0]!.name, row: 2, name: saeonUniverse.statusSamples.preHire.name }),
    });
    const rrnInput = rowDetailRegion.getByLabel(new RegExp(t("importReview.identifier.rrn").replace(/[()]/g, "\\$&")));
    const f4Synthetic = rrn("1995-05-05", 6, 12345);
    await rrnInput.fill(f4Synthetic);
    const idSelect = rowDetailRegion.getByLabel(new RegExp(t("importReview.identifier.idType")));
    await expect(idSelect).toHaveValue("ARC");
    await idSelect.selectOption("DOMESTIC_RESIDENCE");
    await rowDetailRegion.getByRole("button", { name: t("importReview.identifier.save"), exact: true }).click();
    await expect(rowDetailRegion.getByText(t("enum.idType.DOMESTIC_RESIDENCE"))).toBeVisible();
    await expect(rowDetailRegion.getByText(t("import.rows.preHireBadge"))).toHaveCount(0);
    await expect(rowDetailRegion.getByText(t("import.rows.sexDerived", { sex: t("import.sex.FEMALE") }))).toBeVisible();

    expect(importAdmin.unexpected).toEqual([]);
  } finally {
    importAdmin.release();
  }

  // 2. Roster consoleTools link to /people/data-health + KPI/side-pane + /people?ids= drilldown
  await page.goto("about:blank");
  await page.unrouteAll({ behavior: "ignoreErrors" });
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

    // Drill down from rrn_missing summary row into /people?ids=...
    await page.getByRole("button", { name: new RegExp(t("dataHealth.stat.all")) }).click();
    const summaryGrid = page.getByRole("table", { name: t("dataHealth.summary.title") });
    const rrnRow = summaryGrid.getByRole("row").filter({ hasText: t("dataHealth.field.rrn_missing") });
    await rrnRow.getByRole("link", { name: t("dataHealth.summary.openRoster") }).click();
    await expect(page).toHaveURL(/\/people\?ids=/);
    expect(admin.unexpected).toEqual([]);
  } finally {
    admin.release();
  }

  // 3. View-only permission gating on /people/data-health (must NOT call hr_basic:edit endpoints or show latest_import)
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
    await expect(page.getByText(t("dataHealth.latestImportOpen"))).toHaveCount(0);
    expect(gatedCalls).toEqual([]);
    expect(viewer.unexpected).toEqual([]);
  } finally {
    viewer.release();
  }

  // 4. Data health empty & 403 refused states via GET /api/v1/hr/people/data-health
  await page.goto("about:blank");
  await page.unrouteAll({ behavior: "ignoreErrors" });
  const emptyFix = await setupConsoleSaeonPeople(page, { experience: "console", canManage: true });
  await mockRoute(page, "get", "/api/v1/hr/people/data-health", {
    status: 200,
    json: {
      ...saeonPeopleDataHealth({ canManage: true }),
      cohort: { total: 0, active: 0, on_leave: 0, pre_hire: 0 },
      drilldown_items: [],
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
  await mockRoute(page, "get", "/api/v1/hr/people/data-health", { status: 403, json: failure("forbidden") });
  try {
    await page.goto("/people/data-health");
    await expect(page.getByRole("main").getByRole("heading", { name: t("common.denied.title.plain"), exact: true })).toBeVisible();
  } finally {
    refusedFix.release();
  }

  // 5. Baseline fallback preservation for /people/import, /people/unplaced, /people/data-health
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

test("Console /people/records/import previews, gates name mismatch acknowledgment, and applies section rows", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const fixture = await setupConsoleSaeonPeople(page, { experience: "console", canManage: true });
  let appliedBody: unknown = null;
  const empId = "00000000-0000-4000-8350-000000000101";
  await mockRoute(page, "post", "/api/v1/employee-records/{section}/import/preview", {
    status: 200,
    json: {
      section: "EDUCATION",
      applied: false,
      rows: [
        { row: 1, employee_id: empId, stored_name: "Stored Person", name_mismatch: true, outcome: "CREATE", entry_id: null, code: null, message: null },
        { row: 2, employee_id: null, stored_name: null, name_mismatch: false, outcome: "ERROR", entry_id: null, code: "employee_not_found", message: "No matching employee" },
      ],
      plan_digest: "digest-edu-wave4-test-0001",
    },
  });
  await mockRoute(page, "post", "/api/v1/employee-records/{section}/import/apply", req => {
    appliedBody = req.postDataJSON();
    return {
      status: 200,
      json: {
        section: "EDUCATION" as const,
        applied: true,
        rows: [
          { row: 1, employee_id: empId, stored_name: "Stored Person", name_mismatch: true, outcome: "CREATE" as const, entry_id: empId, code: null, message: null },
          { row: 2, employee_id: null, stored_name: null, name_mismatch: false, outcome: "ERROR" as const, entry_id: null, code: "employee_not_found", message: "No matching employee" },
        ],
        plan_digest: "digest-edu-wave4-test-0001",
      },
    };
  });
  try {
    await page.goto("/people/records/import");
    await expect(page.locator('[data-pattern="wizard"]')).toHaveCount(1);
    await page.getByLabel(t("empRec.import.pasteLabel")).fill("employee_number,employee_name,school,degree,major,graduated_on\n10001,Sheet Name,SNU,BS,CS,2020-02-20\n99999,Missing,KAIST,MS,AI,2022-02-20");
    await page.getByRole("button", { name: t("empRec.import.previewAction"), exact: true }).click();
    const applyBtn = page.getByRole("button", { name: t("empRec.import.applyAction", { count: 1 }), exact: true });
    await expect(applyBtn).toHaveAttribute("aria-disabled", "true");
    await page.getByText(t("empRec.import.mismatchAck", { count: 1 }), { exact: true }).click();
    await expect(applyBtn).not.toHaveAttribute("aria-disabled", "true");
    await applyBtn.click();
    await expect(page.getByText(t("empRec.import.appliedReceipt", { written: 1, errors: 1 })).first()).toBeVisible();
    await expect(page.getByRole("button", { name: t("empRec.import.downloadSkippedCsv", { count: 1 }), exact: true })).toBeVisible();
    expect(appliedBody).toMatchObject({ plan_digest: "digest-edu-wave4-test-0001", acknowledge_name_mismatch: true });
    expect(fixture.unexpected).toEqual([]);
  } finally {
    fixture.release();
  }
});
