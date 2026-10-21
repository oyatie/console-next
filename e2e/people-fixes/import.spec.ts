import { expect, test } from "@playwright/test";
import { expectAccessible } from "../a11y";
import { go } from "../flows";
import { apiOf, bearerOf } from "../helpers/api";
import { chooseWorkbook } from "../helpers/import";
import { workbook } from "../helpers/import-layouts";
import { peopleWorld } from "../helpers/people-fixes";

async function previewAndApply(page: import("@playwright/test").Page, lines: string[][], count: string) {
  await chooseWorkbook(page, "고용정보.xlsx", await workbook([{ name: "재직자", lines }]));
  await page.getByRole("button", { name: "명부 미리보기" }).click();
  await page.getByRole("button", { name: "모의 반영 실행" }).click();
  await page.getByRole("button", { name: count, exact: true }).click();
  await expect(page.getByRole("heading", { name: "명부를 반영했습니다" })).toBeVisible({ timeout: 60_000 });
}

test("solo: a migrated worker without employment follows the guided re-import diff without creating another person", { tag: ["@hr", "@regression"] }, async ({ browser }) => {
  test.setTimeout(300_000);
  const { admin } = await peopleWorld(browser, "peopleimport");
  const api = apiOf(admin, bearerOf(admin));
  await go(admin, "/people/import");
  await previewAndApply(admin, [["사번", "성명", "입사일"], ["PM-0001", "이관인", "2024-01-02"]], "명부 반영: 신규 1명 · 갱신 0명");
  const rows = async () => ((await (await api("/employees?employee_number=PM-0001")).json()) as { items: { id: string }[] }).items;
  const id = (await rows())[0]!.id;
  const detail = async () => (await (await api(`/employees/${id}`)).json()) as { employment: { employment_type: string } | null };
  expect((await detail()).employment).toBeNull();
  await go(admin, `/people/${id}`);
  await expect(admin.getByText("고용 정보를 먼저 등록하십시오", { exact: true })).toBeVisible();
  await expect(admin.getByText(/사번 PM-0001과 같은 이름이 있는 명부/)).toBeVisible();
  await expectAccessible(admin, "people: missing employment names the reviewed re-import path");
  await admin.getByRole("link", { name: "명부 재이관으로 고용 정보 등록" }).click();
  await previewAndApply(admin, [["사번", "성명", "입사일", "고용형태"], ["PM-0001", "이관인", "2024-01-02", "정규직"]], "명부 반영: 신규 0명 · 갱신 1명");
  expect((await rows()).map((r) => r.id)).toEqual([id]);
  expect((await detail()).employment?.employment_type).toBe("REGULAR");
  await go(admin, `/people/${id}`);
  await expect(admin.getByRole("link", { name: "명부 재이관으로 고용 정보 등록" })).toHaveCount(0);
  await expect(admin.getByText("정규직", { exact: true }).first()).toBeVisible();
});
