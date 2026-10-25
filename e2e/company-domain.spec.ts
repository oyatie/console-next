import { expect, test } from "@playwright/test";
import { expectAccessible } from "./a11y";
import { tenantOnboardSubmit, tenantSlugField, firstSignIn, go, passkeyLogin, takeCode, unique, vendorPage, vendorStepUp } from "./flows";

test("company domain: deliberate opening, safe rename, old-domain sign-in notice and support request", { tag: "@auth" }, async ({ browser }) => {
  const old = unique("domain-before");
  const next = unique("domain-after");
  const v = await vendorPage(browser);
  await go(v, "/platform");
  await v.getByRole("button", { name: "고객 계정 개설" }).click();
  const opening = v.getByRole("dialog", { name: "고객 계정 개설" });
  const domain = tenantSlugField(opening);
  await opening.getByLabel("고객 이름").fill("도메인 고객");
  await expect(domain).toHaveValue(""); // A company name never supplies a guess.
  await domain.fill("ab");
  await expect(domain).toHaveAttribute("aria-invalid", "true");
  await domain.fill("platform");
  await expect(domain).toHaveAttribute("aria-invalid", "true");
  await domain.fill("");
  await opening.getByLabel("고객이 제공한 홈페이지 또는 업무용 이메일 (선택)").fill(`https://${old}.com`);
  await opening.getByRole("button", { name: `${old} 사용` }).click();
  await expect(domain).toHaveValue(old);
  await expect(opening).toContainText(`hong@${old}`);
  await expect(opening).toContainText("사용 가능한 회사 도메인입니다");
  await expectAccessible(v, "opening company-domain preview");
  await tenantOnboardSubmit(v).click();
  const admin = await firstSignIn(browser, await takeCode(v));
  await go(admin, "/account");
  const oldId = (await admin.locator(".code").filter({ hasText: `@${old}` }).first().innerText()).trim();
  await admin.getByRole("link", { name: old, exact: true }).click();
  await expect(admin).toHaveURL(/\/settings\/company-domain$/);
  await expect(admin.getByText(`회사 도메인: ${old}`, { exact: true })).toBeVisible();
  await admin.getByRole("button", { name: "변경 요청", exact: true }).click();
  const request = admin.getByRole("dialog", { name: "변경 요청" });
  await request.getByLabel("요청할 회사 도메인").fill(next);
  await expect(request.getByRole("button", { name: "변경 요청", exact: true })).toBeEnabled();
  await expectAccessible(admin, "tenant domain-change request");
  await request.getByRole("button", { name: "변경 요청", exact: true }).click();
  await expect(request).not.toBeVisible();
  await expect(admin.getByText(/변경을 요청했습니다. 플랫폼 운영자의 처리를 기다립니다/ )).toBeVisible();
  await go(v, "/account");
  await expect(v.getByRole("heading", { name: "내 계정", exact: true })).toBeVisible();
  await go(v, "/platform");
  await v.getByRole("row").filter({ hasText: old }).click();
  await expect(v.getByRole("complementary").getByText(next, { exact: true })).toBeVisible();

  await v.getByRole("button", { name: "회사 도메인 변경", exact: true }).click();
  const rename = v.getByRole("dialog", { name: "회사 도메인 변경" });
  await tenantSlugField(rename).fill(next);
  await expect(rename).toContainText("다른 고객 계정에 다시 발급되지 않습니다");
  await expectAccessible(v, "operator company-domain rename");
  await vendorStepUp(async () => {
    await rename.getByRole("button", { name: "회사 도메인 변경", exact: true }).click();
    await expect(v.locator("#tenants-receipt")).toContainText(next);
  });
  await v.getByRole("button", { name: "회사 도메인 변경", exact: true }).click();
  await tenantSlugField(rename).fill(old);
  await expect(rename).toContainText("이미 쓰거나 이전에 쓴 회사 도메인");
  await expect(rename.getByRole("button", { name: "회사 도메인 변경", exact: true })).toBeDisabled();
  await rename.getByRole("button", { name: "돌아가기" }).click();

  await admin.getByRole("button", { name: "로그아웃", exact: true }).click();
  await admin.getByRole("textbox", { name: "아이디", exact: true }).fill(oldId);
  await admin.getByRole("button", { name: "아이디로 계속", exact: true }).click();
  await passkeyLogin(admin);
  await expect(admin.getByRole("status").filter({ hasText: "회사 도메인이" })).toContainText(`${oldId.split("@")[0]}@${next}`);
  await expect.poll(() => admin.evaluate(() => JSON.parse(localStorage.getItem("console.signIn.domains") ?? "[]"))).toEqual([next]);
  await go(admin, "/settings/company-domain");
  await expect(admin.getByText(`회사 도메인: ${next}`, { exact: true })).toBeVisible();
  await expectAccessible(admin, "renamed company domain");
  // Permanent aliases remain searchable in the platform directory.
  await v.getByRole("textbox", { name: "고객 계정 검색" }).fill(old);
  await expect(v.getByRole("row").filter({ hasText: next })).toBeVisible();
});
