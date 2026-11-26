// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test, type Page } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import type { components } from "@console/api";
import { tenantBeforeSetup } from "../setup-flows";
import { setTheme } from "../shell";
import { chooseWorkbook } from "../helpers/import";
import ExcelJS from "exceljs";
import { readFileSync } from "node:fs";

type Preview = components["schemas"]["EmployeeImportPreviewResponse"];
const sheetName = "Synthetic roster";
test.beforeAll(() => loadCatalog("ko"));
const regionName = () => t("importSheet.sheet", { name: sheetName });
const saveName = () => t("importSheet.map.save", { name: sheetName });

async function upload(page: Page): Promise<Preview> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(sheetName);
  sheet.addRow(["name", "rrn", "phone", "position"]);
  const catalogue = JSON.parse(readFileSync(new URL("../../backend/crates/hr/domain/data/employee.json", import.meta.url), "utf8")) as { fields: { target: string; example: string }[] };
  sheet.addRow(["Synthetic person", catalogue.fields.find(f => f.target === "rrn")!.example, "01012345678", "Synthetic title"]);
  if (new URL(page.url()).pathname !== "/people/import") await page.goto("/people/import");
  await chooseWorkbook(page, "synthetic.xlsx", Buffer.from(await workbook.xlsx.writeBuffer()));
  const response = page.waitForResponse(r => r.request().method() === "POST" && r.url().endsWith("/employees/import/preview"));
  await page.getByRole("button", { name: t("import.preview"), exact: true }).click();
  const result = await response;
  expect(result.ok()).toBe(true);
  return result.json();
}

test("unconfirmed restricted and ordinary columns wait for a person's mapping @hr @regression", async ({ browser }) => {
  const { admin } = await tenantBeforeSetup(browser, "confirmcolumns", "Column confirmation", false, "none");
  await admin.setViewportSize({ width: 390, height: 900 });
  await admin.emulateMedia({ colorScheme: "dark" });
  await setTheme(admin, "dark");
  const preview = await upload(admin);
  await expect(admin.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(preview.input_rows).toBe(0);
  expect(preview.sealed_identities).toBe(0);
  expect(preview.sample_rows).toEqual([]);
  expect(preview.sheets_needing_mapping).toBe(1);
  expect(preview.sheets[0]).toMatchObject({ status: "needs_mapping", needs_confirmation: true, rows: 1, header_row: 1 });
  await expect(admin.getByText(t("importSheet.needs", { count: 1 }))).toHaveCount(0);
  await expect(admin.getByText(t("importSheet.confirmation", { count: 1 }), { exact: true })).toBeVisible();
  await expect(admin.getByRole("table", { name: t("import.columns"), exact: true })).toHaveCount(0);
  await expect(admin.getByText(t("import.stat.preserved"), { exact: true })).toHaveCount(0);
  await expect(admin.getByText(t("import.stat.sealed"), { exact: true })).toHaveCount(0);
  await expect(admin.getByRole("button", { name: t("import.dryRun"), exact: true })).toHaveAttribute("aria-disabled", "true");
  const sheet = admin.getByRole("region", { name: regionName(), exact: true });
  await expect(sheet.getByRole("combobox")).toHaveCount(4);
  for (const theme of ["light", "dark"]) {
    await admin.locator("html").evaluate((el, value) => { el.dataset.theme = value; }, theme);
    expect(await admin.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await expect(sheet.getByRole("combobox")).toHaveCount(4);
  }
  await sheet.getByRole("combobox").first().focus();
  await admin.keyboard.press("Tab");
  await expect(sheet.getByRole("combobox").nth(1)).toBeFocused();
  for (const select of await sheet.getByRole("combobox").all()) {
    const box = await select.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  }
  const response = admin.waitForResponse(r => r.request().method() === "POST" && r.url().endsWith("/employees/import/preview"));
  await sheet.getByRole("button", { name: saveName(), exact: true }).click();
  const result = await response;
  expect(result.ok()).toBe(true);
  const confirmed: Preview = await result.json();
  expect(confirmed.input_rows).toBe(1);
  expect(confirmed.sealed_identities).toBe(1);
  expect(confirmed.sheets_needing_mapping).toBe(0);
  await admin.context().close();
});

test("remembered exclusions remain unbound for exact restricted keys @hr @regression", async ({ browser }) => {
  const { admin } = await tenantBeforeSetup(browser, "excludedcolumns", "Excluded columns", false, "none");
  await upload(admin);
  const sheet = admin.getByRole("region", { name: regionName(), exact: true });
  const open = sheet.getByRole("button", { name: t("importSheet.remap", { name: sheetName }), exact: true });
  if (await open.count()) await open.click();
  await sheet.getByRole("combobox", { name: t("importSheet.map.target", { sheet: sheetName, column: "B", label: "rrn" }), exact: true }).selectOption("");
  await sheet.getByRole("combobox", { name: t("importSheet.map.target", { sheet: sheetName, column: "C", label: "phone" }), exact: true }).selectOption("");
  const response = admin.waitForResponse(r => r.request().method() === "POST" && r.url().endsWith("/employees/import/preview"));
  await sheet.getByRole("button", { name: saveName(), exact: true }).click();
  expect((await response).ok()).toBe(true);
  const preview = await upload(admin);
  expect(preview.sealed_identities).toBe(0);
  expect(preview.input_rows).toBe(0);
  const columns = preview.sheets[0]!.columns!;
  const excluded = columns.filter(c => c.label === "rrn" || c.label === "phone");
  expect(excluded).toHaveLength(2);
  for (const column of excluded) {
    expect(column.target).toBeNull();
    expect(column.source).toBe("remembered");
  }
  const editor = admin.getByRole("region", { name: regionName(), exact: true });
  await expect(editor.getByRole("combobox").nth(1)).toHaveValue("");
  await expect(editor.getByRole("combobox").nth(2)).toHaveValue("");
  await admin.context().close();
});
