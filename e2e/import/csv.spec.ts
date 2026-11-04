// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { go } from "../flows";
import { tenantInSetup } from "../setup-flows";
import { apiOf, bearerOf } from "../helpers/api";

test("a CP949 roster reaches preview, apply and employee search without conversion @hr @regression", async ({ browser }) => {
  test.setTimeout(240_000);
  const { admin } = await tenantInSetup(browser, "csvroster", "명부가져오기", false, "본사");
  await go(admin, "/people/import");
  const chooser = admin.waitForEvent("filechooser");
  await admin.getByRole("button", { name: "파일 선택", exact: true }).click();
  await (await chooser).setFiles({ name: "명부.csv", mimeType: "text/csv", buffer: Buffer.from("bbe7b9f82cbcbab8ed2cc0d4bbe7c0cf2cb0edbfebc7fcc5c20d0a4353562d303030312c8c63b0a1b3aa2c323032342d30332d30342cc1a4b1d4c1f70d0a", "hex") });
  await admin.getByRole("button", { name: "명부 미리보기", exact: true }).click();
  await admin.getByRole("button", { name: "모의 반영 실행", exact: true }).click();
  await expect(admin.getByRole("main")).toContainText("똠가나");
  await admin.getByRole("button", { name: "명부 반영: 신규 1명 · 갱신 0명", exact: true }).click();
  await expect(admin.getByRole("heading", { name: "명부를 반영했습니다", exact: true })).toBeVisible({ timeout: 60_000 });
  const api = apiOf(admin, bearerOf(admin));
  const result = await api("/employees?employee_number=CSV-0001");
  expect(result.ok()).toBe(true);
  const people = await result.json() as { items: { name: string; employee_number: string }[] };
  expect(people.items.map(({ name, employee_number }) => ({ name, employee_number }))).toEqual([{ name: "똠가나", employee_number: "CSV-0001" }]);
  await go(admin, "/people");
  await admin.getByRole("searchbox", { name: "이름 또는 사번", exact: true }).fill("CSV-0001");
  await expect(admin.getByRole("row").filter({ hasText: "똠가나" })).toBeVisible();
});
