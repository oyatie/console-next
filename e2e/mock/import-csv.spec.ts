// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import ExcelJS from "exceljs";
import { expectAxe, fits } from "../a11y";
import { id } from "./fixtures";
import { mockPeopleImport } from "./people-import";
import { mockRoute } from "./route";

const text = "사번,성명,입사일,고용형태\r\nCSV-0001,똠가나,2024-03-04,정규직\r\n";
const cp949 = Buffer.from("bbe7b9f82cbcbab8ed2cc0d4bbe7c0cf2cb0edbfebc7fcc5c20d0a4353562d303030312c8c63b0a1b3aa2c323032342d30332d30342cc1a4b1d4c1f70d0a", "hex");

for (const [encoding, buffer, mimeType] of [
  ["UTF-8", Buffer.from(text), "text/csv"],
  ["UTF-8 BOM", Buffer.from(`\uFEFF${text}`), "text/csv"],
  ["CP949", cp949, ""],
] as const) test(`${encoding} CSV uses the existing roster preview @ui-state`, async ({ page }) => {
  const fixture = await mockPeopleImport(page, "empty");
  let cells: ExcelJS.CellValue[] = [];
  await mockRoute(page, "post", "/api/v1/employees/import/preview", async request => {
    const form = await new Request(request.url(), { method: "POST", headers: request.headers(), body: new Uint8Array(request.postDataBuffer()!) }).formData();
    const file = form.get("file") as File;
    expect(file.name).toBe("명부.xlsx");
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await file.arrayBuffer());
    cells = workbook.worksheets[0]!.getRow(2).values as ExcelJS.CellValue[];
    return { status: 200, json: {
      run_id: id(4001), entity_type: "employee_hr" as const, source_filename: file.name, source_sha256: "a".repeat(64),
      input_rows: 1, candidate_rows: 1, preserved_rows: 0, sealed_identities: 0,
      columns: [], sample_rows: [], mapping_profile: {}, sheets: [], sheets_needing_mapping: 0, available_targets: [],
    } };
  });
  try {
    await page.goto("/people/import");
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "파일 선택", exact: true }).click();
    await (await chooser).setFiles({ name: "명부.CSV", mimeType, buffer });
    const preview = page.getByRole("button", { name: "명부 미리보기", exact: true });
    await expect(preview).not.toHaveAttribute("aria-disabled", "true");
    await preview.click();
    await expect(page.getByRole("button", { name: "모의 반영 실행", exact: true })).toBeVisible();
    expect(cells).toEqual([undefined, "CSV-0001", "똠가나", "2024-03-04", "정규직"]);
    expect(fixture.unexpected).toEqual([]);
  } finally { await page.close(); fixture.release(); }
});

test("a late CSV decode failure cannot replace the next file selection @ui-state", async ({ page }) => {
  const fixture = await mockPeopleImport(page, "empty");
  await page.addInitScript(() => {
    const original = File.prototype.arrayBuffer;
    File.prototype.arrayBuffer = function (this: File) {
      return this.name === "previous.csv" ? new Promise<ArrayBuffer>((_resolve, reject) => {
        (window as unknown as { failPrevious: () => void }).failPrevious = () => reject(new TypeError());
      }) : original.call(this);
    };
  });
  try {
    await page.goto("/people/import");
    const choose = async (name: string) => {
      const chooser = page.waitForEvent("filechooser");
      await page.getByRole("button", { name: "파일 선택", exact: true }).click();
      await (await chooser).setFiles({ name, mimeType: "text/csv", buffer: Buffer.from(text) });
    };
    await choose("previous.csv");
    await expect(page.getByText("선택한 파일: previous.csv", { exact: true })).toBeVisible();
    await page.waitForFunction(() => typeof (window as unknown as { failPrevious?: () => void }).failPrevious === "function");
    await choose("current.csv");
    const preview = page.getByRole("button", { name: "명부 미리보기", exact: true });
    await expect(preview).not.toHaveAttribute("aria-disabled", "true");
    await page.evaluate(async () => {
      (window as unknown as { failPrevious: () => void }).failPrevious();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    await expect(page.getByText("선택한 파일: current.csv", { exact: true })).toBeVisible();
    await expect(preview).not.toHaveAttribute("aria-disabled", "true");
    await expect(page.getByRole("alert")).toHaveCount(0);
    expect(fixture.unexpected).toEqual([]);
  } finally { await page.close(); fixture.release(); }
});

for (const width of [1440, 390]) test(`unreadable CSV offers paste without uploading at ${width}px @ui-state`, async ({ page }, info) => {
  const fixture = await mockPeopleImport(page, "empty");
  let uploads = 0;
  await page.route("**/api/v1/employees/import/preview", route => { uploads++; return route.abort(); });
  try {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/people/import");
    await expect(page.getByRole("button", { name: "파일 선택", exact: true })).toBeVisible();
    for (const theme of ["light", "dark"]) {
      await page.locator("html").evaluate((el, value) => { el.dataset.theme = value; }, theme);
      await page.screenshot({ path: info.outputPath(`upload-${theme}.png`), fullPage: true });
    }
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "파일 선택", exact: true }).click();
    await (await chooser).setFiles({ name: "읽지못함.csv", mimeType: "text/csv", buffer: Buffer.from([0xb0]) });
    await expect(page.getByRole("alert")).toContainText("목록 붙여넣기");
    await expect(page.getByRole("button", { name: "명부 미리보기", exact: true })).toHaveAttribute("aria-disabled", "true");
    for (const theme of ["light", "dark"]) {
      await page.locator("html").evaluate((el, value) => { el.dataset.theme = value; }, theme);
      await fits(page, `CSV refusal/${width}/${theme}`);
      await page.screenshot({ path: info.outputPath(`refused-${theme}.png`), fullPage: true });
    }
    await expectAxe(page, `CSV refusal/${width}`);
    await page.getByText("목록 붙여넣기", { exact: true }).click();
    await expect(page.getByRole("textbox", { name: /직원 목록/ })).toBeVisible();
    expect(uploads).toBe(0);
    expect(fixture.unexpected).toEqual([]);
  } finally { await page.close(); fixture.release(); }
});
