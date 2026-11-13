// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test, type Page } from "@playwright/test";
import type { components } from "@console/api";
import { tenantBeforeSetup } from "../setup-flows";
import { chooseWorkbook } from "../helpers/import";
import ExcelJS from "exceljs";
import { readFileSync } from "node:fs";

type Preview = components["schemas"]["EmployeeImportPreviewResponse"];
const sheetName = "Synthetic roster";
const regionName = `${sheetName} 시트`;
const saveName = `${sheetName} 시트를 이 연결로 다시 읽기`;

async function upload(page: Page): Promise<Preview> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(sheetName);
  sheet.addRow(["name", "rrn", "phone", "position"]);
  const catalogue = JSON.parse(readFileSync(new URL("../../backend/crates/hr/domain/data/employee.json", import.meta.url), "utf8")) as { fields: { target: string; example: string }[] };
  sheet.addRow(["Synthetic person", catalogue.fields.find(f => f.target === "rrn")!.example, "01012345678", "Synthetic title"]);
  if (new URL(page.url()).pathname !== "/people/import") await page.goto("/people/import");
  await chooseWorkbook(page, "synthetic.xlsx", Buffer.from(await workbook.xlsx.writeBuffer()));
  const response = page.waitForResponse(r => r.request().method() === "POST" && r.url().endsWith("/employees/import/preview"));
  await page.getByRole("button", { name: "명부 미리보기", exact: true }).click();
  const result = await response;
  expect(result.ok()).toBe(true);
  return result.json();
}

test("unconfirmed restricted and ordinary columns wait for a person's mapping @hr @regression", async ({ browser }) => {
  const { admin } = await tenantBeforeSetup(browser, "confirmcolumns", "열확인", false, "none");
  await admin.setViewportSize({ width: 390, height: 900 });
  await admin.emulateMedia({ colorScheme: "dark" });
  if (await admin.locator("html").getAttribute("data-theme") !== "dark") {
    await admin.getByRole("button", { name: "어두운 화면으로 전환", exact: true }).click();
  }
  const preview = await upload(admin);
  await expect(admin.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(preview.input_rows).toBe(0);
  expect(preview.sealed_identities).toBe(0);
  expect(preview.sample_rows).toEqual([]);
  expect(preview.sheets_needing_mapping).toBe(1);
  await expect(admin.getByRole("button", { name: "모의 반영 실행", exact: true })).toHaveAttribute("aria-disabled", "true");
  const sheet = admin.getByRole("region", { name: regionName, exact: true });
  await expect(sheet.getByRole("combobox")).toHaveCount(4);
  for (const select of await sheet.getByRole("combobox").all()) {
    const box = await select.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  }
  const response = admin.waitForResponse(r => r.request().method() === "POST" && r.url().endsWith("/employees/import/preview"));
  await sheet.getByRole("button", { name: saveName, exact: true }).click();
  const result = await response;
  expect(result.ok()).toBe(true);
  const confirmed: Preview = await result.json();
  expect(confirmed.input_rows).toBe(1);
  expect(confirmed.sealed_identities).toBe(1);
  expect(confirmed.sheets_needing_mapping).toBe(0);
  await admin.context().close();
});

test("remembered exclusions remain unbound for exact restricted keys @hr @regression", async ({ browser }) => {
  const { admin } = await tenantBeforeSetup(browser, "excludedcolumns", "제외열", false, "none");
  await upload(admin);
  const sheet = admin.getByRole("region", { name: regionName, exact: true });
  const open = sheet.getByRole("button", { name: `${sheetName} 시트 다시 연결`, exact: true });
  if (await open.count()) await open.click();
  await sheet.getByRole("combobox", { name: `${sheetName} 시트 B열(rrn)의 직원 항목`, exact: true }).selectOption("");
  await sheet.getByRole("combobox", { name: `${sheetName} 시트 C열(phone)의 직원 항목`, exact: true }).selectOption("");
  const response = admin.waitForResponse(r => r.request().method() === "POST" && r.url().endsWith("/employees/import/preview"));
  await sheet.getByRole("button", { name: saveName, exact: true }).click();
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
  const editor = admin.getByRole("region", { name: regionName, exact: true });
  await expect(editor.getByRole("combobox").nth(1)).toHaveValue("");
  await expect(editor.getByRole("combobox").nth(2)).toHaveValue("");
  await admin.context().close();
});
