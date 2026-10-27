// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { expectAccessible } from "./a11y";
import { go, option } from "./flows";
import { openTenant } from "./helpers/tenant";
import { brnDisplay, pickKind, registerEntity, registerWorkplace, REGISTRATION_FIXTURES, typeAddress, workplaceSheet } from "./setup-flows";
test.beforeAll(() => loadCatalog("ko"));

for (const mode of ["exempt", "abstract", "later-to-exempt"] as const) {
  test(`${mode}: registration answers finish without warning and show the entity filing number`, { tag: ["@org", "@regression"] }, async ({ browser }) => {
    const page = await openTenant(browser, `workplace-answer-${mode}`, "새온그룹");
    await go(page, "/org/entities/new");
    await registerEntity(page, "새온정밀");
    const recordPath = new URL(page.url()).pathname;
    await page.getByRole("link", { name: "사업장 추가" }).first().click();
    await registerWorkplace(page, "새온정밀", "서울 본사");
    await go(page, recordPath);
    await page.getByRole("link", { name: "사업장 추가" }).first().click();
    const sheet = workplaceSheet(page);
    const name = mode === "abstract" ? "원격 근무지 묶음" : "물류 하치장";
    await sheet.getByLabel("사업장 이름").fill(name);
    await option(page, "사업자등록", mode === "later-to-exempt" ? "나중에 연결" : "등록 대상 아님").click();
    if (mode !== "later-to-exempt") {
      await expect(sheet.getByRole("button", { name: "사업장 추가", exact: true })).toHaveAttribute("aria-disabled", "true");
      await sheet.getByRole("combobox", { name: "등록 미대상 사유" }).fill(mode === "abstract" ? "원격" : "하치장");
      const reason = page.getByRole("option", { name: mode === "abstract" ? "주소 없는 원격 근무지 묶음" : "하치장", exact: true });
      await expect(reason).not.toContainText(/REMOTE_TELEWORK|VAT_DEPOT/);
      await reason.click();
    }
    if (mode !== "abstract") await typeAddress(page, "소재지", "서울특별시 종로구 세종대로 209", "03171");
    else await expect(sheet.getByRole("group", { name: "소재지", exact: true })).toHaveCount(0);
    await pickKind(sheet);
    await sheet.getByRole("radiogroup", { name: /^원천징수 신고/ }).getByText(/에서 함께 신고$/).click();
    await option(page, "4대보험", "모두 성립 · 번호는 나중에").click();
    await expectAccessible(page, `${mode} create sheet`);
    await sheet.getByRole("button", { name: "사업장 추가", exact: true }).click();
    await expect(sheet).toBeHidden();

    if (mode === "later-to-exempt") {
      await go(page, "/org/entities");
      await page.getByRole("button", { name: `${name} 등록증 연결` }).click();
      const attach = page.getByRole("dialog", { name: `${name} 등록증 연결` });
      await option(page, "사업자등록", "등록 대상 아님").click();
      await attach.getByRole("combobox", { name: "등록 미대상 사유" }).fill("하치장");
      await page.getByRole("option", { name: "하치장", exact: true }).click();
      const revised = page.waitForResponse((r) => r.request().method() === "PUT" && /\/workplaces\/[^/]+$/.test(new URL(r.url()).pathname));
      await attach.getByRole("button", { name: "변경 저장", exact: true }).click();
      expect((await revised).ok()).toBe(true);
      await expect(attach).toBeHidden();
      await expect(page.getByRole("region", { name: "등록증을 연결하지 않은 사업장" })).toBeHidden();
    }
    await go(page, recordPath);
    const row = page.getByRole("row", { name: new RegExp(name) });
    await expect(row).toContainText(`${t("workplace.filing.entityBasis")} · ${brnDisplay(REGISTRATION_FIXTURES.primary.brn)}`);
    await page.getByRole("tab", { name: /^사업장 \d/ }).click();
    await page.getByRole("row", { name: new RegExp(name) }).click();
    const panel = page.getByRole("complementary", { name });
    await expect(panel).not.toContainText("등록증 없음");
    await expect(panel).not.toContainText("주소 입력 필요");
    await expect(panel).toContainText(mode === "abstract" ? "원격" : "하치장");
    await expect(panel).toContainText(brnDisplay(REGISTRATION_FIXTURES.primary.brn));
    if (mode === "abstract") await expect(panel.getByRole("button", { name: "소재지 수정" })).toHaveCount(0);
    await expectAccessible(page, `${mode} panel`);
    await go(page, "/setup/go-live");
    await expect(page.getByRole("heading", { name: t("setup.golive.title"), level: 1 })).toBeVisible();
    await expect(page.getByRole("heading", { name: t("setup.golive.governed"), level: 2 })).toBeVisible();
    await expect(page.getByRole("main")).not.toContainText(/등록증이 없는 (?:빈 )?사업장/);
    await expectAccessible(page, `${mode} go-live`);
  });
}
