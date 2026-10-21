import { expect, test } from "@playwright/test";
import { expectAccessible } from "../a11y";
import { go } from "../flows";
import { tenantInSetup } from "../setup-flows";
import { chooseWorkbook } from "../helpers/import";
import { workbook } from "../helpers/import-layouts";
import { apiOf, bearerOf } from "../helpers/api";

// regression (r3:hire-19): a conflict pattern could only be excluded row by row; 재직 with a future 입사일 had no
// way in. Now the pattern takes one answer for every row (here 「입사 예정으로 가져오기」), taken back the same way.
test("import conflict answers: 재직 with a future 입사일 comes in 입사 예정 by one answer for every row", { tag: ["@hr", "@regression"] }, async ({ browser }) => {
  test.setTimeout(240_000);
  const { admin } = await tenantInSetup(browser, "conflictans", "답하기상사", false, "답하기 본점");
  const api = apiOf(admin, bearerOf(admin));
  const lines = [["사번", "성명", "입사일", "재직상태"], ["CA-0001", "고미래", "2099-03-02", "재직"], ["CA-0002", "나미래", "2099-04-01", "재직"]];
  await go(admin, "/people/import");
  await chooseWorkbook(admin, "명부.xlsx", await workbook([{ name: "재직자", lines }]));
  await admin.getByRole("button", { name: "명부 미리보기" }).click();
  await admin.getByRole("button", { name: "모의 반영 실행" }).click();
  const answer = admin.getByRole("button", { name: "입사 예정으로 가져오기 (2행)" });
  await expect(answer).toBeVisible({ timeout: 30_000 });
  await expectAccessible(admin, "import: a conflict pattern answered once");
  await answer.click();
  await expect(admin.getByText("재직인데 입사일이 오늘 뒤인 행: 입사 예정으로")).toBeVisible({ timeout: 30_000 });
  const apply = admin.getByRole("button", { name: "명부 반영: 신규 2명 · 갱신 0명" });
  await expect(apply).toBeEnabled({ timeout: 30_000 });
  await apply.click();
  await expect(admin.getByRole("heading", { name: "명부를 반영했습니다" })).toBeVisible({ timeout: 60_000 });
  const items = ((await (await api("/employees?limit=10")).json()) as { items: { status?: string | null }[] }).items;
  expect(items.map((e) => e.status)).toEqual(["PRE_HIRE", "PRE_HIRE"]);
});
