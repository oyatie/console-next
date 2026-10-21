import ExcelJS from "exceljs";
import { expect, test } from "@playwright/test";
import { expectAccessible } from "./a11y";
import { go } from "./flows";
import { openUnit, panel } from "./helpers/structure";
import { tenantInSetup } from "./setup-flows";
import { shot } from "./shots";

// UX-R3 STRUCT org-06: an org sheet that names each 부서's 상위부서 (and its 부서코드) keeps the hierarchy — 구매파트 lands
// under 총무팀 with its code, never 「사업장 바로 아래」 — and a row whose parent is found nowhere is refused by that name.
// regression: on the parent 상위부서 could only be a path level or left out, and 부서코드 said 「저장할 곳이 없어」.

test("regression: a 상위부서 column keeps the hierarchy, the code is kept, and an unknown parent is refused by name (org-06)", { tag: ["@org", "@regression"] }, async ({ browser }) => {
  const { admin: page } = await tenantInSetup(browser, "orgimpparent", "상위상사", false, "서울 본사");
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("부서");
  for (const r of [
    ["사업장", "부서", "상위부서", "부서코드"],
    ["서울 본사", "총무팀", "", "GA"],
    ["서울 본사", "구매파트", "총무팀", "GA-P"],
    ["서울 본사", "고아파트", "없는팀", ""],
  ])
    ws.addRow(r);
  await go(page, "/org/import");
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "파일 선택" }).click();
  await (await chooser).setFiles({ name: "상위.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from(await wb.xlsx.writeBuffer()) });
  await expect(page.getByLabel("상위부서 열")).toHaveValue("parent");
  await expect(page.getByLabel("부서코드 열")).toHaveValue("code");
  await expect(page.getByText("상위 부서 이름으로 계층을 구성합니다", { exact: false })).toBeVisible();
  await expectAccessible(page, "org import: a parent column");
  await page.getByRole("button", { name: "다음: 값 연결" }).click();
  await page.getByRole("button", { name: "다음: 미리보기" }).click();

  await expect(page.getByText("4행 · 상위 부서 없는팀을 시트에서도 조직도에서도 하나로 찾지 못했습니다")).toBeVisible();
  const plan = page.getByRole("list", { name: "추가될 모습" });
  await expect(plan.getByRole("listitem").filter({ hasText: "구매파트" })).toBeVisible();
  await shot(page, "after-org-06-import-parent-preview");
  await page.getByRole("button", { name: /^오류 행 제외 후 적용/ }).click();
  await expect(page.getByRole("status").filter({ hasText: "기록됨" })).toBeVisible();

  // On the chart 구매파트 sits under 총무팀, with its code.
  await go(page, "/org");
  const p = await openUnit(page, "구매파트");
  await expect(p).toContainText("총무팀");
  await expect(panel(page, "구매파트")).toContainText("GA-P");
});
