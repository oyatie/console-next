// SPDX-License-Identifier: LicenseRef-Proprietary
import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { go, option } from "./flows";
import { openTenant } from "./helpers/tenant";
import { brnDisplay, pickKind, registerEntity, typeAddress, workplaceSheet } from "./setup-flows";

const ids = JSON.parse(readFileSync(new URL("./entity-individual-identifiers.json", import.meta.url), "utf8")) as { primary: { brn: string }; second: { brn: string } };
const tab = (page: Page, name: string) => page.getByRole("group", { name: "법인 정보 보기" }).getByRole("button", { name: new RegExp(`^${name}(?:\\s|$)`) });

async function wizardCertificate(page: Page, brn: string) {
  await page.getByRole("textbox", { name: /^사업자등록번호/ }).fill(brn);
  await page.getByRole("textbox", { name: /^개업연월일/ }).fill("2020-03-02");
  await typeAddress(page, "사업장 소재지", "서울특별시 강남구 테헤란로 152", "06236");
  await page.getByRole("textbox", { name: /^업태/ }).fill("정보통신업");
  await page.getByRole("textbox", { name: /^종목/ }).fill("소프트웨어 개발");
  await option(page, "사업자 단위 과세 적용", "부").click();
  await option(page, "과세유형", "일반과세자").click();
  await page.getByRole("textbox", { name: /^관할 세무서/ }).fill("삼성세무서");
}

async function certificate(page: Page, name: string, brn: string) {
  await page.getByLabel("사업자등록번호").fill(brn);
  await page.getByRole("textbox", { name: /^상호/ }).fill(name);
  await page.getByLabel("개업연월일").fill("2020-03-02");
  await typeAddress(page, "사업장 소재지", "서울특별시 강남구 테헤란로 152", "06236");
  await page.getByRole("textbox", { name: /^업태/ }).fill("정보통신업");
  await page.getByRole("textbox", { name: /^종목/ }).fill("소프트웨어 개발");
  await option(page, "사업자 단위 과세 적용", "적용 안 함").click();
  await page.getByLabel("과세유형").selectOption({ label: "일반과세자" });
  await page.getByLabel("관할 세무서 (등록증 표기)").fill("삼성세무서");
}

async function correct(page: Page, card: ReturnType<Page["getByRole"]>, field: string, value: string) {
  await card.getByRole("button", { name: `${field} 수정`, exact: true }).click();
  const sheet = page.getByRole("dialog", { name: `${field} 수정`, exact: true });
  await option(page, "무엇을 기록합니까", "처음부터 잘못 적었습니다 · 정정").click();
  await sheet.getByRole("textbox", { name: new RegExp(`^${field}`) }).fill("");
  await expect(sheet.getByRole("button", { name: "정정 기록", exact: true })).toHaveAttribute("aria-disabled", "true");
  await sheet.getByRole("textbox", { name: new RegExp(`^${field}`) }).fill(value);
  await sheet.getByRole("button", { name: "정정 기록", exact: true }).click();
  await expect(sheet).toBeHidden();
}

test("each individual's certificate owns its 상호 through entity edits and certificate corrections", { tag: ["@org", "@regression"] }, async ({ browser }) => {
  const page = await openTenant(browser, "individual-trade", "상호 시험");
  await go(page, "/org/entities/new");
  await option(page, "사업자 구분", "개인사업자").click();
  await page.getByRole("textbox", { name: /^상호/ }).fill("가나상회");
  await page.getByRole("button", { name: "다음", exact: true }).click();
  await page.getByRole("textbox", { name: /^대표자|^성명/ }).first().fill("홍길동");
  await wizardCertificate(page, ids.primary.brn);
  await page.getByRole("button", { name: "다음", exact: true }).click();
  await page.getByRole("button", { name: "법인만 등록", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: /가나상회/ })).toBeVisible();
  const record = new URL(page.url()).pathname;
  const certs = () => page.getByRole("region", { name: /^사업자등록증(?: · 본점)?$/, exact: false });
  await expect(certs().first().getByText("가나상회", { exact: true })).toBeVisible();

  await page.getByRole("link", { name: "사업장 추가" }).first().click();
  const workplace = workplaceSheet(page);
  await workplace.getByLabel("사업장 이름").fill("역삼 사업장");
  await option(page, "사업자등록", "이 사업장의 등록증").click();
  await certificate(page, "가나상회 2호점", ids.second.brn);
  await option(page, "부가가치세 신고 단위", "사업장별").click();
  await pickKind(workplace);
  await option(page, "원천징수 신고 사업장", "이 사업장에서 신고").click();
  await option(page, "이 사업장이 주된 사업장입니까", "주된 사업장").click();
  await option(page, "4대보험", "모두 성립 · 번호는 나중에").click();
  await workplace.getByRole("button", { name: "사업장 추가", exact: true }).click();
  await expect(workplace).toBeHidden();
  await go(page, record);
  await tab(page, "사업자등록증").click();
  await expect(certs()).toHaveCount(2);
  const first = certs().filter({ hasText: brnDisplay(ids.primary.brn) });
  const second = certs().filter({ hasText: brnDisplay(ids.second.brn) });
  await expect(first.getByText("가나상회", { exact: true })).toBeVisible();
  await expect(second.getByText("가나상회 2호점", { exact: true })).toBeVisible();
  await tab(page, "개요").click();
  const registry = page.getByRole("region", { name: "대표 · 연락처", exact: true });
  await expect(registry.getByRole("button", { name: "상호 수정", exact: true })).toHaveCount(0);
  await correct(page, registry, "명칭", "가나상회 본점");
  await tab(page, "사업자등록증").click();
  await expect(first.getByText("가나상회", { exact: true })).toBeVisible();
  await expect(second.getByText("가나상회 2호점", { exact: true })).toBeVisible();
  await correct(page, second, "상호", "가나상회 역삼점");
  await expect(second.getByText("가나상회 역삼점", { exact: true })).toBeVisible();
  await expect(first.getByText("가나상회", { exact: true })).toBeVisible();
  await second.getByRole("button", { name: `${brnDisplay(ids.second.brn)} 등록증 재발급·정정`, exact: true }).click();
  const reissue = page.getByRole("dialog", { name: "등록증 재발급·정정", exact: true });
  await option(page, "발급 사유", "변경 · 정정신고로 다시 받음").click();
  await reissue.getByRole("button", { name: "상호 · 가나상회 역삼점", exact: true }).click();
  await expect(reissue.getByRole("textbox", { name: /^상호/ })).toHaveValue("가나상회 역삼점");
  await reissue.getByRole("button", { name: "취소", exact: true }).click();
  await expect(reissue).toBeHidden();
  await page.getByRole("group", { name: "법인 정보 보기" }).getByRole("button", { name: /^이력/ }).click();
  await expect(page.getByRole("region", { name: "이력", exact: true })).toContainText(/상호.*가나상회 2호점.*→.*가나상회 역삼점/s);
});

test("corporate certificate item one still edits the entity name", { tag: "@org" }, async ({ browser }) => {
  const page = await openTenant(browser, "corporate-trade", "법인명 시험");
  await go(page, "/org/entities/new");
  await registerEntity(page, "가나");
  const card = page.getByRole("region", { name: "사업자등록증", exact: true });
  await expect(card.getByText("주식회사 가나", { exact: true })).toBeVisible();
  await card.getByRole("button", { name: "법인명(단체명) 수정", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "법인명(단체명) 수정" });
  await option(page, "무엇을 기록합니까", "처음부터 잘못 적었습니다 · 정정").click();
  await sheet.getByRole("textbox", { name: /^법인명\(단체명\)/ }).fill("주식회사 새가나");
  await sheet.getByRole("button", { name: "정정 기록", exact: true }).click();
  await expect(sheet).toBeHidden();
  await expect(card.getByText("주식회사 새가나", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("주식회사 새가나");
});
