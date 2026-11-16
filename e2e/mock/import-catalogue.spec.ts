// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { fits } from "../a11y";
import { id } from "./fixtures";
import { mockPeopleImport } from "./people-import";
import { mockRoute } from "./route";

test.beforeAll(() => loadCatalog("ko"));

for (const confirmation of [false, true]) for (const width of [390, 1440]) for (const theme of ["light", "dark"]) {
  test(`served import targets populate column choices ${confirmation ? "awaiting confirmation" : "awaiting mapping"} at ${width}px ${theme} @ui-state`, async ({ page }, info) => {
    await page.emulateMedia({ colorScheme: theme as "light" | "dark" });
    await page.setViewportSize({ width, height: 900 });
    const fixture = await mockPeopleImport(page, "empty");
    await mockRoute(page, "post", "/api/v1/employees/import/preview", { status: 200, json: {
      run_id: id(4001), entity_type: "employee_hr", source_filename: "synthetic-roster.xlsx", source_sha256: "a".repeat(64),
      input_rows: 0, candidate_rows: 0, preserved_rows: 0, sealed_identities: 0,
      columns: [], sample_rows: [], mapping_profile: {}, sheets_needing_mapping: 1,
      available_targets: ["name", "company_brn", "future_target"],
      sheets: [{ name: "Synthetic sheet", status: confirmation ? "needs_confirmation" : "needs_mapping", rows: 1, ...(confirmation ? { header_row: 1, columns: [{ column: "A", label: "Synthetic name", target: "name", source: "catalog" }, { column: "B", label: "Synthetic registry column with a long descriptive header", target: "company_brn", source: "catalog" }] } : {}), header_candidates: [{ row: 1, cells: [
        { column: "A", label: "Synthetic name" }, { column: "B", label: "Synthetic registry column with a long descriptive header" },
      ] }] }],
    } });
    try {
      await page.goto("/people/import");
      const chooser = page.waitForEvent("filechooser");
      await page.getByRole("button", { name: t("uiFileDrop.pick"), exact: true }).click();
      await (await chooser).setFiles({ name: "synthetic-roster.csv", mimeType: "text/csv", buffer: Buffer.from("name,registry\r\nSynthetic person,Synthetic registry\r\n") });
      await page.getByRole("button", { name: t("import.preview"), exact: true }).click();
      const sheet = page.getByRole("region", { name: t("importSheet.sheet", { name: "Synthetic sheet" }), exact: true });
      await sheet.getByRole("radiogroup").getByText(t("importSheet.map.row", { row: 1 }), { exact: true }).click();
      if (confirmation) {
        await expect(page.getByText(t("importSheet.needs", { count: 1 }))).toHaveCount(0);
        await expect(page.getByText(t("importSheet.confirmation", { count: 1 }), { exact: true })).toBeVisible();
        await expect(sheet.getByText(t("importSheet.rows", { count: 1 }), { exact: true }).first()).toBeVisible();
        await expect(sheet.getByText(t("importSheet.status.needs_confirmation"), { exact: true })).toBeVisible();
        await expect(page.getByRole("table", { name: t("import.columns"), exact: true })).toHaveCount(0);
        await expect(page.getByText(t("import.stat.preserved"), { exact: true })).toHaveCount(0);
        await expect(page.getByRole("button", { name: t("import.dryRun"), exact: true })).toHaveAttribute("aria-disabled", "true");
      } else {
        await expect(page.getByText(t("importSheet.needs", { count: 1 }))).toBeVisible();
      }
      const choices = sheet.getByRole("combobox");
      await expect(choices).toHaveCount(2);
      for (const select of await choices.all()) {
        await expect(select.getByRole("option")).toHaveText([t("importSheet.map.notImported"), t("import.target.name"), t("import.target.company_brn"), "future_target"]);
        const box = await select.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(width);
      }
      await choices.first().focus();
      await page.keyboard.press("Tab");
      await expect(choices.nth(1)).toBeFocused();
      await choices.nth(0).selectOption("name");
      await choices.nth(1).selectOption("company_brn");
      await expect(sheet.getByRole("button", { name: t("importSheet.map.save", { name: "Synthetic sheet" }), exact: true })).toBeEnabled();
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await fits(page, `import targets/${width}/${theme}`);
      await choices.last().scrollIntoViewIfNeeded();
      await page.screenshot({ path: info.outputPath("columns.png"), fullPage: true });
      expect(fixture.unexpected).toEqual([]);
    } finally { await page.close(); fixture.release(); }
  });
}
