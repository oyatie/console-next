// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { expectAxe, fits } from "../a11y";
import { failure, id, user } from "./fixtures";
import { mockPeopleImport } from "./people-import";
import { mockRoute } from "./route";

test.beforeAll(() => loadCatalog("ko"));

for (const [status, code, message] of [
  [403, "import_apply_forbidden", "import.error.import_apply_forbidden"],
  [409, "import_apply_timed_out", "import.error.import_apply_timed_out"],
] as const) for (const job of [false, true]) for (const width of [1440, 390]) test(`${code} keeps the dry run and recovery: job=${job} at ${width}px @ui-state`, async ({ page }, info) => {
  const fixture = await mockPeopleImport(page, "empty");
  let writes = 0;
  let jobReads = 0;
  const run = id(4001);
  const failed = { run_id: run, state: "failed", total: 1, done: 0, requested_by: user.id,
    dry_run_digest: "a".repeat(64), error: { code, message: "private database detail" } };
  await mockRoute(page, "post", "/api/v1/employees/import/preview", { status: 200, json: {
    run_id: run, entity_type: "employee_hr", source_filename: "roster.xlsx", source_sha256: "a".repeat(64),
    input_rows: 1, candidate_rows: 1, preserved_rows: 0, sealed_identities: 0,
    columns: [], sample_rows: [], mapping_profile: {}, sheets: [], sheets_needing_mapping: 0, available_targets: [],
  } });
  await mockRoute(page, "post", "/api/v1/employees/import/{run_id}/dry-run", { status: 200, json: {
    run_id: run, input_rows: 1, candidate_rows: 1, preserved_rows: 0, insert_candidates: 1, update_candidates: 0,
    unchanged_rows: 0, excluded_rows: 0, unsettled_rows: 0, companies: [], org_unit_bound_rows: 0,
    org_unit_unbound_rows: 1, unresolved_org_units: [], dry_run_digest: "a".repeat(64), decisions: {}, rows: [],
    review: { count: 0, blocking: 0, items: [], groups: [] }, remembered: [], auto_mapped: [],
    employment_type_empty_rows: 0, unplaced: { rows: 0, by_reason: {} }, phone_unstored_rows: 0,
  } });
  await page.route("**/api/v1/employees/import/*/apply", route => {
    if (route.request().method() === "POST") {
      writes++;
      return route.fulfill(job ? { status: 202, json: failed } : { status, json: failure(code) });
    }
    jobReads++;
    return route.fulfill({ status: 200, json: failed });
  });
  try {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/people/import");
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: t("uiFileDrop.pick"), exact: true }).click();
    await (await chooser).setFiles({ name: "roster.csv", mimeType: "text/csv", buffer: Buffer.from("name\r\nExample\r\n") });
    await page.getByRole("button", { name: t("import.preview"), exact: true }).click();
    await page.getByRole("button", { name: t("import.dryRun"), exact: true }).click();
    const apply = page.getByRole("button", { name: t("import.apply", { insert: 1, update: 0 }), exact: true });
    await apply.click();
    await expect(page.getByRole("alert")).toContainText(t(message));
    await expect(page.getByRole("alert")).not.toContainText("private database detail");
    for (const theme of ["light", "dark"]) {
      await page.locator("html").evaluate((el, value) => { el.dataset.theme = value; }, theme);
      await fits(page, `${code}/${width}/${theme}`);
      await page.screenshot({ path: info.outputPath(`${theme}.png`), fullPage: true });
    }
    await expectAxe(page, `${code}/${width}`);
    if (job) await page.getByRole("button", { name: t("importJob.back"), exact: true }).click();
    await expect(apply).toHaveCount(1);
    await expect(apply).toBeEnabled();
    await expect(page.getByRole("heading", { name: t("import.dry.title"), exact: true })).toBeVisible();
    await page.getByRole("button", { name: t("import.otherFile"), exact: true }).click();
    await expect(page.getByRole("button", { name: t("uiFileDrop.pick"), exact: true })).toBeVisible();
    expect(writes).toBe(1);
    expect(jobReads > 0).toBe(job);
    expect(fixture.unexpected).toEqual([]);
  } finally { await page.close(); fixture.release(); }
});
