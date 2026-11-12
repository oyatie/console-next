// SPDX-License-Identifier: LicenseRef-Proprietary
import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { go } from "../flows";
import { tenantBeforeSetup } from "../setup-flows";
import { chooseWorkbook } from "../helpers/import";
import { workbook } from "../helpers/import-layouts";

test("inconsistent ZIP headers refuse an employee workbook and allow a valid replacement", { tag: ["@hr", "@regression"] }, async ({ browser }) => {
  const { admin } = await tenantBeforeSetup(browser, "zipheaders", "파일검증", false, "none");
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
  const previewed = admin.waitForResponse((response) => response.url().endsWith("/employees/import/preview") && response.request().method() === "POST");
  await admin.getByRole("button", { name: "명부 미리보기" }).click();
  expect((await previewed).status()).toBe(200);
  await expect(admin.locator('[aria-current="step"]')).toHaveText("열 확인");
  await expect(admin.getByRole("table", { name: "열", exact: true })).toContainText("성명");
});

test("reversed worksheet dimensions show the corrupt-file refusal and allow a valid replacement", { tag: ["@hr", "@regression"] }, async ({ browser }) => {
  const { admin } = await tenantBeforeSetup(browser, "dimensions", "범위검증", false, "none");
  await go(admin, "/people/import");
  for (const fixture of [
    "backend/fuzz/regressions/fz5-reversed-dimension.xlsx",
    "backend/app/src/hr/fixtures/dimension-doctype-lower.xlsx",
    "backend/app/src/hr/fixtures/dimension-doctype-mixed.xlsx",
    "backend/app/src/hr/fixtures/dimension-namespace.xlsx",
    "backend/app/src/hr/fixtures/dimension-slash.xlsx",
    "backend/app/src/hr/fixtures/dimension-comment-overlap.xlsx",
    "backend/app/src/hr/fixtures/dimension-duplicate-rels.xlsx",
  ]) {
    const reversed = await readFile(new URL(`../../${fixture}`, import.meta.url));
    await chooseWorkbook(admin, "reversed.xlsx", reversed);
    const refused = admin.waitForResponse((response) => response.url().endsWith("/employees/import/preview") && response.request().method() === "POST");
    await admin.getByRole("button", { name: "명부 미리보기" }).click();
    const response = await refused;
    expect(response.status()).toBe(422);
    expect(await response.json()).toMatchObject({ error: { code: "workbook_corrupt" } });
    await expect(admin.getByRole("alert")).toContainText("손상된 파일입니다. 엑셀에서 열어 다시 저장한 다음 올리십시오.");
  }

  const valid = await workbook([{ name: "재직자", lines: [["사번", "성명", "입사일"], ["DM-0001", "한여름", "2024-03-04"]] }]);
  await chooseWorkbook(admin, "valid.xlsx", valid);
  const previewed = admin.waitForResponse((response) => response.url().endsWith("/employees/import/preview") && response.request().method() === "POST");
  await admin.getByRole("button", { name: "명부 미리보기" }).click();
  expect((await previewed).status()).toBe(200);
  await expect(admin.locator('[aria-current="step"]')).toHaveText("열 확인");
  await expect(admin.getByRole("table", { name: "열", exact: true })).toContainText("성명");
});

for (const part of ["svg", "pivot", "custom"]) {
  test(`valid workbook with ${part} XML reaches column mapping`, { tag: ["@hr", "@regression"] }, async ({ browser }) => {
    const { admin } = await tenantBeforeSetup(browser, `xml${part}`, "파일검증", false, "none");
    const valid = await readFile(new URL(`../../backend/app/src/hr/fixtures/dimension-${part}.xlsx`, import.meta.url));
    await go(admin, "/people/import");
    await chooseWorkbook(admin, "valid.xlsx", valid);
    const previewed = admin.waitForResponse((response) => response.url().endsWith("/employees/import/preview") && response.request().method() === "POST");
    await admin.getByRole("button", { name: "명부 미리보기" }).click();
    expect((await previewed).status()).toBe(200);
    await expect(admin.locator('[aria-current="step"]')).toHaveText("열 확인");
    await expect(admin.getByRole("table", { name: "열", exact: true })).toContainText("성명");
  });
}
