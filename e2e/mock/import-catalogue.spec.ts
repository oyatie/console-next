// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { fits } from "../a11y";
import { id } from "./fixtures";
import { mockPeopleImport } from "./people-import";
import { mockRoute } from "./route";

for (const width of [390, 1440]) for (const theme of ["light", "dark"]) {
  test(`served import targets populate column choices at ${width}px ${theme} @ui-state`, async ({ page }, info) => {
    await page.emulateMedia({ colorScheme: theme as "light" | "dark" });
    await page.setViewportSize({ width, height: 900 });
    const fixture = await mockPeopleImport(page, "empty");
    await mockRoute(page, "post", "/api/v1/employees/import/preview", { status: 200, json: {
      run_id: id(4001), entity_type: "employee_hr", source_filename: "synthetic-roster.xlsx", source_sha256: "a".repeat(64),
      input_rows: 1, candidate_rows: 1, preserved_rows: 0, sealed_identities: 0,
      columns: [], sample_rows: [], mapping_profile: {}, sheets_needing_mapping: 1,
      available_targets: ["name", "company_brn", "future_target"],
      sheets: [{ name: "Synthetic sheet", status: "needs_mapping", rows: 1, header_candidates: [{ row: 1, cells: [
        { column: "A", label: "Synthetic name" }, { column: "B", label: "Synthetic registry column with a long descriptive header" },
      ] }] }],
    } });
    try {
      await page.goto("/people/import");
      const chooser = page.waitForEvent("filechooser");
      await page.getByRole("button", { name: "파일 선택", exact: true }).click();
      await (await chooser).setFiles({ name: "synthetic-roster.csv", mimeType: "text/csv", buffer: Buffer.from("name,registry\r\nSynthetic person,Synthetic registry\r\n") });
      await page.getByRole("button", { name: "명부 미리보기", exact: true }).click();
      const sheet = page.getByRole("region", { name: "Synthetic sheet 시트", exact: true });
      await sheet.getByRole("radiogroup").getByText("1행", { exact: true }).click();
      const choices = sheet.getByRole("combobox");
      await expect(choices).toHaveCount(2);
      for (const select of await choices.all()) {
        await expect(select.getByRole("option")).toHaveText(["가져오지 않음", "성명", "사업자등록번호", "future_target"]);
        const box = await select.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(width);
      }
      await choices.nth(0).selectOption("name");
      await choices.nth(1).selectOption("company_brn");
      await expect(sheet.getByRole("button", { name: "Synthetic sheet 시트를 이 연결로 다시 읽기", exact: true })).toBeEnabled();
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await fits(page, `import targets/${width}/${theme}`);
      await choices.last().scrollIntoViewIfNeeded();
      await page.screenshot({ path: info.outputPath("columns.png"), fullPage: true });
      expect(fixture.unexpected).toEqual([]);
    } finally { await page.close(); fixture.release(); }
  });
}
