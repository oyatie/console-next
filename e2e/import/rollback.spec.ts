// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { expectAccessible } from "../a11y";
import { go } from "../flows";
import { tenantInSetup } from "../setup-flows";
import { apiOf, bearerOf, codeOf } from "../helpers/api";
import { chooseWorkbook } from "../helpers/import";
import { workbook } from "../helpers/import-layouts";
import { settled } from "../helpers/import-queue";

test("J-ONB-19: the applied run opens with file, actor, time and stored counts from recent imports", { tag: ["@hr", "@negative"] }, async ({ browser }) => {
  test.setTimeout(240_000);
  const { admin } = await tenantInSetup(browser, "rollbackrecord", "되돌리기테스트", false, "테스트 본점");
  const api = apiOf(admin, bearerOf(admin));
  await go(admin, "/people/import");
  await chooseWorkbook(admin, "되돌리기명부.xlsx", await workbook([{ name: "명부", lines: [
    ["사번", "성명", "입사일", "고용형태"],
    ["RB-001", "가테스트", "2020-03-02", "정규직"],
    ["RB-002", "나테스트", "2021-04-01", "정규직"],
  ] }]));
  const previewed = admin.waitForResponse(r => r.request().method() === "POST" && new URL(r.url()).pathname.endsWith("/import/preview"));
  await admin.getByRole("button", { name: "명부 미리보기" }).click();
  const run = ((await (await previewed).json()) as { run_id: string }).run_id;
  await admin.getByRole("button", { name: "모의 반영 실행" }).click();
  await settled(admin);
  await admin.getByRole("button", { name: /^명부 반영: 신규 2명/ }).click();
  await expect(admin.getByRole("heading", { name: "명부를 반영했습니다" })).toBeVisible({ timeout: 60_000 });
  const done = admin.getByRole("region", { name: "명부를 반영했습니다" });
  await expect(done.getByRole("heading", { name: "되돌리기명부.xlsx" })).toBeVisible();
  await expect(done.locator("time")).toHaveAttribute("datetime", /T/);
  await expect(done.locator("time")).toContainText(/반영했습니다/);
  await expect(done).toContainText("신규 2명");
  await expectAccessible(admin, "import run record: file, actor, time, counts");

  await admin.getByRole("link", { name: "다른 명부 가져오기" }).click();
  const recent = admin.getByRole("region", { name: "최근 가져오기" });
  const link = recent.getByRole("link", { name: "되돌리기명부.xlsx" });
  await expect(link).toHaveAttribute("href", `/people/import?run=${run}`);
  await expectAccessible(admin, "import recent runs");
  await link.click();
  await expect(done.getByRole("heading", { name: "되돌리기명부.xlsx" })).toBeVisible();
  await expect(done).toContainText("신규 2명");
  const missing = await api(`/employee-import-runs/${crypto.randomUUID()}`);
  expect([missing.status(), await codeOf(missing)]).toEqual([404, "import_run_not_found"]);
  await expect(done).toContainText("신규 2명");
});
