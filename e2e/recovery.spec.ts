import { expect, test } from "@playwright/test";
import { expectAccessible } from "./a11y";
import { clickCounter } from "./clicks";
import { tenantSlugField, firstSignIn, go, newContext, takeCode, unique, vendorPage, vendorStepUp } from "./flows";
import { inviteAccount } from "./access-flows";

// Lost codes and lost passkeys: the vendor reissues a first-admin code; an admin resets a user's passkeys.
test("vendor reissues a lost first-admin code; an admin resets a user's passkeys and they enroll again", { tag: "@auth" }, async ({ browser }) => {
  const c = clickCounter();
  const v = await vendorPage(browser);
  await go(v, "/platform");
  await v.getByRole("button", { name: "고객 계정 개설" }).click();
  const company = unique("복구주식회사");
  const slug = unique("recoverco");
  await v.getByLabel("고객 이름").fill(company);
  await tenantSlugField(v).fill(slug);
  await v.getByRole("button", { name: "개설하고 코드 발급" }).click();
  const lost = (await v.getByLabel("일회용 코드").textContent())!.trim();
  // The code dialog ignores Escape and outside clicks: only its own button closes it, and it claims no delivery.
  await v.keyboard.press("Escape");
  await expect(v.getByRole("dialog")).toContainText("닫으면 다시 볼 수 없습니다");
  await v.getByRole("button", { name: "코드 닫기" }).click();
  await expect(v.getByRole("dialog")).toBeHidden();

  // The new tenant's panel is open: reissue states its consequence and its precondition before the first press.
  const tenant = v.getByRole("complementary", { name: company });
  await expect(v.locator("#tenants-list tbody tr").filter({ hasText: slug })).toBeVisible();
  await expect(tenant).toContainText("이전에 발급한 코드는 바로 쓸 수 없게 됩니다");
  await expect(tenant).toContainText("패스키로 본인임을 한 번 더 확인"); // the reissue asks for a step-up first
  await expect(tenant).toContainText("관리자가 패스키를 등록하기 전까지만 재발급할 수 있습니다");
  await expectAccessible(v, "tenant panel");
  // The vendor's own passkey is asserted first; the server mints nothing without that step-up.
  const stepUp = v.waitForResponse((r) => r.url().endsWith("/api/v1/auth/passkey/login/start"));
  const code = await vendorStepUp(async () => {
    await c.click(tenant.getByRole("button", { name: "패스키로 확인하고 관리자 코드 재발급" }));
    return takeCode(v, true);
  });
  expect((await stepUp).ok()).toBe(true);
  expect(c.done("vendor reissues the first-admin code")).toBeLessThanOrEqual(2);
  await expect(v.locator("#tenants-receipt")).toContainText(`${company} 첫 관리자 코드를 다시 발급했습니다`);

  // The replaced code no longer signs in.
  const stale = await (await newContext(browser)).newPage();
  await stale.goto("/login");
  await stale.getByLabel("일회용 코드").fill(lost);
  await stale.getByRole("button", { name: "코드로 로그인" }).click();
  await expect(stale.getByRole("alert")).toBeVisible();
  await stale.context().close();

  const admin = await firstSignIn(browser, code, undefined, true);
  // A fresh read disables reissue before any refused press, and names the governed recovery path.
  await v.reload();
  await v.getByRole("row").filter({ hasText: slug }).click();
  await expect(tenant.getByRole("button", { name: "패스키로 확인하고 관리자 코드 재발급" })).toHaveAttribute("aria-disabled", "true");
  await expect(tenant).toContainText("관리자가 이미 패스키를 등록해 코드를 다시 발급하지 않습니다");
  await expectAccessible(v, "reissue refused after enrollment");
  const exec = await firstSignIn(browser, await inviteAccount(admin, "이임원", "oversight", true), undefined, true);
  await expect(exec.getByRole("heading", { name: "이임원님" })).toBeVisible();

  // The executive lost their device: the admin resets their passkeys and hands over a new code.
  // A fresh load: the admin's account list predates the executive's enrollment.
  await admin.goto("/people?view=accounts");
  await c.click(admin.getByRole("row", { name: /이임원/ }));
  const panel = admin.getByRole("complementary", { name: "이임원" });
  await c.click(panel.getByRole("button", { name: "패스키 초기화" }));
  const reset = admin.getByRole("dialog", { name: "패스키 초기화" });
  await expect(reset).toContainText("되돌릴 수 없습니다");
  await expectAccessible(admin, "credential reset dialog");
  // The reset asks for the admin's own passkey first (step-up), then shows a code named for what happened.
  await c.click(reset.getByRole("button", { name: "패스키로 확인하고 패스키 초기화" }));
  await expect(admin.getByRole("dialog", { name: "패스키 초기화 로그인 코드" })).toBeVisible();
  const resetCode = await takeCode(admin, true);
  expect(c.done("admin resets a user's passkeys")).toBeLessThanOrEqual(4);
  await expect(panel).toContainText("패스키 없음");
  await expect(panel.getByRole("status")).toContainText("이임원님의 패스키를 초기화하고");

  // The user signs in with the new code (consent was already given) and enrolls a new passkey.
  const again = await firstSignIn(browser, resetCode, undefined, true);
  await expect(again.getByRole("heading", { name: "이임원님" })).toBeVisible();
});
