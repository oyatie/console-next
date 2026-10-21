import { expect, test } from "@playwright/test";
import { expectAccessible } from "../a11y";
import { go } from "../flows";
import { tenantInSetup } from "../setup-flows";
import { chooseWorkbook, payPeriod } from "../helpers/import";
import { many, plain, workbook } from "../helpers/import-layouts";
import { gridRow, queue, rowsGrid } from "../helpers/import-queue";

// A large roster through the import screens (IMPORT-2, BE-MIG W11): over import.apply.max_rows (2,000 by default) the
// dry run is refused with both numbers and the way out; at the limit the dry run's rows are a virtualised grid (only
// what is on screen is in the page) and a value shared by 666+ rows is one question.

test("large files: 3,000 rows refused with the limit named; 2,000 rows virtualised, one question per shared value", { tag: ["@hr", "@negative"] }, async ({ browser }) => {
  test.setTimeout(240_000);
  const { admin } = await tenantInSetup(browser, "importbig", "대량상사", false, "대량 본점");
  await go(admin, "/people/import");
  await chooseWorkbook(admin, "전사명부_3000.xlsx", await workbook([plain("전사", many("BG", 3000, ["인사팀", "영업팀", "품질팀"]))]));
  await payPeriod(admin);
  await admin.getByRole("button", { name: "명부 미리보기" }).click();
  await admin.getByRole("button", { name: "모의 반영 실행" }).click();
  await expect(admin.getByRole("alert")).toContainText("재직자는 3,000명이라 한 번에 반영할 수 있는 2,000명을 넘습니다", { timeout: 60_000 });
  await expect(rowsGrid(admin)).toHaveCount(0);

  // The way out it names: another (smaller) file, from the start.
  await admin.getByRole("button", { name: "다른 파일" }).first().click();
  await chooseWorkbook(admin, "전사명부_2000.xlsx", await workbook([plain("전사", many("BG", 2000, ["인사팀", "영업팀", "품질팀"]))]));
  await payPeriod(admin);
  await admin.getByRole("button", { name: "명부 미리보기" }).click();
  await admin.getByRole("button", { name: "모의 반영 실행" }).click();

  await expect(rowsGrid(admin)).toBeVisible({ timeout: 60_000 });
  await expect(admin.getByText("2,000행 중 2,000행")).toBeVisible();
  // Three unit names the company does not have: three questions, 666 or 667 rows each, none blocking.
  for (const unit of ["인사팀", "영업팀", "품질팀"]) await expect(await gridRow(queue(admin), unit)).toContainText(/66[67]/);
  expect(await rowsGrid(admin).getByRole("row").count()).toBeLessThan(200);
  await expect(rowsGrid(admin).getByRole("row").filter({ hasText: "BG-2000" })).toHaveCount(0);
  await rowsGrid(admin).scrollIntoViewIfNeeded();
  await rowsGrid(admin).evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  await expect(rowsGrid(admin).getByRole("row").filter({ hasText: "BG-2000" })).toBeVisible();
  await expectAccessible(admin, "import: 2,000-row dry run");
  await expect(admin.getByRole("button", { name: "명부 반영: 신규 2,000명 · 갱신 0명" })).toBeEnabled();
  // Not applied here: the apply-as-a-job path (Prefer: respond-async, BE-MIG W11) is not driven by this screen yet.
});
