import { expect, test } from "@playwright/test";
import { expectAccessible } from "./a11y";
import { go, kstDate, option } from "./flows";
import { openTenant } from "./helpers/tenant";
import { typeAddress } from "./setup-flows";
import { shot } from "./shots";

// UX-R3 STRUCT company-04/32: going back with a flagged 등록번호 never strands it — 다음 still leads on, and the foot's
// 「등록번호 고치러 가기」 opens its step with the field focused. company-05: a 설립 중 법인's 설립등기 shows what it recorded
// (법인등록번호, 회사성립연월일) on the record. regression: on the parent 기본's 다음 was disabled with no way to the field,
// and the backdated 설립등기 revision was shadowed by the founding one (회사성립연월일 「—」).

test("regression: a flagged field is one press away from any step, and 설립등기 shows what it recorded (company-04, company-05)", { tag: ["@org", "@regression"] }, async ({ browser }) => {
  const a = await openTenant(browser, "uxr3-wizard", "마법사그룹");
  await go(a, "/org/entities/new");
  await option(a, "사업자 구분", "법인사업자").click();
  await a.getByLabel("법인명(단체명)").fill("주식회사 마법정밀");
  await a.getByRole("button", { name: "다음", exact: true }).click();
  await a.getByLabel("사업자등록번호").fill("0008162516");
  await expect(a.getByText(/검증 숫자가 맞지 않습니다/).first()).toBeVisible();
  await a.getByRole("button", { name: "이전", exact: true }).click();
  await expect(a.getByRole("heading", { name: "기본", level: 2 })).toBeVisible();
  // The way forward stays open, and the foot names the field with a press that goes there.
  await expect(a.getByRole("button", { name: "다음", exact: true })).not.toHaveAttribute("aria-disabled", "true");
  await expectAccessible(a, "wizard: a flagged field on a later step");
  await shot(a, "after-company-04-wizard-foot-jump");
  await a.getByRole("button", { name: /^등록번호 수정$/ }).first().click();
  await expect(a.getByLabel("사업자등록번호")).toBeFocused();

  // company-05: 설립 중, then its 설립등기 3 days ago; the record shows the number and the date.
  await a.getByRole("button", { name: "이전", exact: true }).click();
  await a.getByRole("checkbox", { name: /설립 중인 법인입니다/ }).check();
  await a.getByRole("button", { name: "다음", exact: true }).click();
  await a.getByRole("textbox", { name: /^대표자/ }).first().fill("홍길동");
  await typeAddress(a, "본점 소재지", "서울특별시 강남구 테헤란로 152", "06236");
  await a.getByRole("button", { name: "다음", exact: true }).click();
  await a.getByRole("button", { name: "법인만 등록" }).click();
  // The head reads 설립 중 alone, never 「계속」 beside it.
  await expect(a.getByRole("heading", { level: 1 }).locator("..")).toContainText("설립 중");
  await expect(a.getByRole("heading", { level: 1 }).locator("..")).not.toContainText("계속");
  await a.getByRole("button", { name: "설립등기 입력" }).click();
  const founded = a.getByRole("dialog", { name: "설립등기 입력" });
  await founded.getByRole("textbox", { name: /^법인등록번호/ }).fill("0002110006241");
  await founded.getByRole("textbox", { name: /^설립등기일/ }).fill(kstDate(-3));
  await founded.getByRole("button", { name: "설립등기 기록" }).click();
  await expect(founded).toBeHidden({ timeout: 15_000 });
  const main = a.getByRole("main");
  await expect(main).toContainText("000211-0006241");
  await expect(main.getByText(/회사성립연월일/).first()).toBeVisible();
  await expect(main).not.toContainText("설립 중");
  await shot(a, "after-company-05-founding-recorded");
});
