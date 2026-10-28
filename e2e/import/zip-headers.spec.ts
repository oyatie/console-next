// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { go } from "../flows";
import { tenantInSetup } from "../setup-flows";
import { chooseWorkbook } from "../helpers/import";
import { workbook } from "../helpers/import-layouts";

test("inconsistent ZIP headers refuse an employee workbook and allow a valid replacement", { tag: ["@hr", "@regression"] }, async ({ browser }) => {
  const { admin } = await tenantInSetup(browser, "zipheaders", "파일검증");
  const original = await workbook([{ name: "재직자", lines: [["사번", "성명", "입사일"], ["ZH-0001", "한여름", "2024-03-04"]] }]);
  const inconsistent = Buffer.from(original);
  const name = Buffer.from("xl/worksheets/sheet1.xml");
  const header = inconsistent.indexOf(name);
  expect(header).toBeGreaterThanOrEqual(30);
  expect(inconsistent.subarray(header - 30, header - 26)).toEqual(Buffer.from("PK\x03\x04"));
  // Change only the local filename; the central directory and cell data remain valid.
  inconsistent[header] = "_".charCodeAt(0);
  await go(admin, "/people/import");
  await chooseWorkbook(admin, "inconsistent.xlsx", inconsistent);
  const refused = admin.waitForResponse((response) => response.url().endsWith("/employees/import/preview") && response.request().method() === "POST");
  await admin.getByRole("button", { name: "명부 미리보기" }).click();
  const response = await refused;
  expect(response.status()).toBe(422);
  expect(await response.json()).toMatchObject({ error: { code: "workbook" } });
  await expect(admin.getByRole("alert")).toBeVisible();

  await chooseWorkbook(admin, "valid.xlsx", original);
  await admin.getByRole("button", { name: "명부 미리보기" }).click();
  await expect(admin.locator('[aria-current="step"]')).toHaveText("열 확인");
  await expect(admin.getByRole("table", { name: "열", exact: true })).toContainText("성명");
});
