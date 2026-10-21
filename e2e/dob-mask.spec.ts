// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { atPhoneWidth, expectAccessible, fits } from "./a11y";
import { koDate, registerEmployee } from "./flows";
import { staffedTenant } from "./setup-flows";
import { fillDate } from "./sheet";
import { shotSet } from "./shots";

test("birth date stays masked across the card until a reason is chosen", { tag: "@hr" }, async ({ browser }) => {
  const { admin } = await staffedTenant(browser, "dob-mask", "마스킹상사");
  await registerEmployee(admin, { name: "한기록", number: "DOB-0001" });
  const facts = admin.getByRole("region", { name: "고용 기록" });
  await facts.getByRole("button", { name: "고용 기록 수정", exact: true }).click();
  const form = facts.getByRole("form", { name: "고용 기록 수정" });
  const birth = "1965-01-01";
  await fillDate(form, birth, "생년월일");
  await form.getByRole("button", { name: "고용 기록 저장" }).click();
  await expect(form).toBeHidden();
  await expect(facts).toContainText("••••-••-••");
  await expect(admin.locator("body")).not.toContainText("1965");
  await expectAccessible(admin, "birth date masked on the personnel card");
  await atPhoneWidth(admin, async () => {
    await fits(admin, "masked birth date");
    await expect(facts.getByRole("button", { name: "생년월일 보기 · 사유를 선택합니다" })).toBeVisible();
  });
  await facts.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await shotSet(admin, "dob-mask--card");

  await facts.getByRole("button", { name: "생년월일 보기 · 사유를 선택합니다" }).click();
  const reveal = admin.getByRole("dialog", { name: /생년월일.*봅니다/ });
  await reveal.getByRole("button", { name: "보기", exact: true }).press("Enter");
  await expect(reveal.getByRole("radiogroup", { name: /왜 봅니까/ }).getByRole("radio").first()).toBeFocused();
  await expect(admin.locator("body")).not.toContainText("1965");
  await reveal.getByRole("radiogroup", { name: /왜 봅니까/ }).getByText("법정 신고", { exact: true }).click();
  await reveal.getByRole("button", { name: "보기", exact: true }).click();
  await expect(facts.getByText(koDate(birth), { exact: true })).toBeVisible();
  await expect(admin.getByText(koDate(birth), { exact: true })).toHaveCount(1);
  await facts.getByRole("button", { name: "가리기", exact: true }).click();
  await expect(facts).toContainText("••••-••-••");
  await expect(admin.locator("body")).not.toContainText("1965");
});

test("family birth dates use the same reason-gated reveal and hide", { tag: "@hr" }, async ({ browser }) => {
  const { admin } = await staffedTenant(browser, "family-dob-mask", "가족마스킹상사");
  await registerEmployee(admin, { name: "한기록", number: "DOB-0002" });
  const family = admin.getByRole("region", { name: "상벌·가족" });
  await family.getByRole("button", { name: "가족 추가", exact: true }).click();
  const editor = family.getByRole("group", { name: "새 가족 줄", exact: true });
  await editor.getByLabel("관계", { exact: true }).selectOption("CHILD");
  await editor.getByRole("textbox", { name: "이름", exact: true }).fill("한가족");
  const birth = "2015-03-04";
  await editor.getByLabel("생년월일", { exact: true }).fill(birth);
  await editor.getByRole("button", { name: "저장", exact: true }).click();
  await expect(editor).toContainText("1줄 저장했습니다");
  await editor.getByRole("button", { name: "닫기", exact: true }).click();
  const row = family.getByRole("table", { name: "가족", exact: true }).getByRole("row");
  await expect(row).toContainText("••••-••-••");
  await expect(admin.locator("body")).not.toContainText("2015");
  await row.getByRole("button", { name: "생년월일 보기 · 사유를 선택합니다", exact: true }).click();
  const reveal = admin.getByRole("dialog", { name: /생년월일.*봅니다/ });
  await reveal.getByRole("button", { name: "보기", exact: true }).press("Enter");
  await expect(reveal.getByRole("radiogroup", { name: /왜 봅니까/ }).getByRole("radio").first()).toBeFocused();
  await expect(admin.locator("body")).not.toContainText("2015");
  await expect(reveal).not.toContainText("한가족");
  await reveal.getByRole("radiogroup", { name: /왜 봅니까/ }).getByText("법정 신고", { exact: true }).click();
  await reveal.getByRole("button", { name: "보기", exact: true }).click();
  await expect(admin.getByText(koDate(birth), { exact: true })).toHaveCount(1);
  await row.getByRole("button", { name: "가리기", exact: true }).click();
  await expect(row).toContainText("••••-••-••");
  await expect(admin.locator("body")).not.toContainText("2015");
  await expectAccessible(admin, "family birth date masked again");
});
