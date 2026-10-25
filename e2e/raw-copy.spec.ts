// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test, type Page } from "@playwright/test";
import { atPhoneWidth, expectAccessible } from "./a11y";
import { go, kstDate } from "./flows";
import { openTenant } from "./helpers/tenant";
import { fillRegister, openRegistered, pressRegister } from "./helpers/register";
import { openHistory } from "./record";
import { forgetResize } from "./stability";
import { setupCompany } from "./setup-flows";

async function accessibleAtBothWidths(page: Page, view: string) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await forgetResize(page);
  await expectAccessible(page, `${view} desktop`);
  await atPhoneWidth(page, () => expectAccessible(page, `${view} phone`));
}

test("RAW: one registration reads in Korean in history, ledger, print, consent and go-live", { tag: ["@org", "@regression"] }, async ({ browser }) => {
  const page = await openTenant(browser, "raw-copy", "새온기록");
  await setupCompany(page, "새온기록", "본사");
  const entity = new URL(page.url()).pathname;
  await page.getByRole("button", { name: /^사업장 \d/ }).click();
  const panel = page.getByRole("complementary", { name: "본사" });
  const history = panel.getByRole("region", { name: "이력" });
  await expect(history).toContainText("건설 사업장 여부: — → 아님");
  await expect(history).not.toContainText(/[a-z]+_[a-z_]+|\b(true|false)\b/);
  const moment = await history.getByRole("link").first().getAttribute("href");
  const workplace = new URL(moment!, page.url()).searchParams.get("wp");
  expect(workplace).toBeTruthy();
  await go(page, `/org?sel=${workplace}`);
  const chartHistory = page.locator("#wp-history");
  await expect(chartHistory).toContainText("건설 사업장 여부: — → 아님");
  await expect(chartHistory).not.toContainText(/[a-z]+_[a-z_]+|\b(true|false)\b/);
  await expect(chartHistory).toBeVisible();
  await expect(page.getByRole("complementary", { name: "본사" })).toBeVisible();
  await accessibleAtBothWidths(page, "org history");

  await go(page, "/people/new");
  await fillRegister(page, { name: "김기록", unit: "본사", hired: kstDate(-1) });
  await pressRegister(page);
  await openRegistered(page, "김기록");
  const person = new URL(page.url()).pathname;
  await openHistory(page);
  const personHistory = page.getByRole("region", { name: "인사 이력", exact: true });
  await expect(personHistory).toContainText("직원 등록");
  await expect(personHistory).not.toContainText(/Created through|created_by_registration/);
  await accessibleAtBothWidths(page, "person history");
  await go(page, `${person}?tab=ledger`);
  await expect(page.getByRole("cell", { name: "직원 등록", exact: true })).toBeVisible();
  await expect(page.locator("main")).not.toContainText("Created through");
  await accessibleAtBothWidths(page, "person ledger");
  await go(page, `${person}?act=print`);
  const preview = page.locator("main");
  await expect(preview).toContainText("직원 등록");
  await expect(preview).not.toContainText("Created through");
  await accessibleAtBothWidths(page, "person print");

  await go(page, "/account");
  const consent = page.getByRole("heading", { name: "동의 내역" }).locator("../..");
  await expect(consent.locator("summary")).toContainText(/.+ · .+ 판 · 전문 보기/);
  await expect(consent).not.toContainText(/kr-pipa|kr-/);
  await consent.locator("summary").click();
  await expect(consent.locator("details")).toHaveAttribute("open", "");
  await accessibleAtBothWidths(page, "account notice");

  await go(page, "/setup/go-live");
  const refused = page.getByRole("alert").filter({ hasText: "이용약관" });
  await expect(refused).toBeVisible();
  expect(await refused.innerText()).not.toContain("terms_not_accepted");
  await refused.getByText("이유 보기", { exact: true }).click();
  await expect(refused.locator("details")).toContainText("onboarding.refuse.terms_not_accepted");
  await accessibleAtBothWidths(page, "go-live reason");
  // Keep the record route exercised even when a print dialog changed search state.
  expect(entity).toMatch(/^\/org\/entities\//);
});
