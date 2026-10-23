import { expect, test } from "@playwright/test";
import { expectAccessible, fits } from "./a11y";
import { authenticatorOf, virtualAuthenticator } from "./auth";
import { clickCounter } from "./clicks";
import { acceptConsent, go, newContext, passkeyLogin, vendorPage } from "./flows";
import { inviteAccount } from "./access-flows";
import { tenantWithExecutive } from "./setup-flows";
import { openTenant } from "./helpers/tenant";

// My account: a second passkey (step-up with the first), sign-in with the new one, then removing the old one.
test("my account: add a second passkey, sign in with it, remove the first", { tag: "@auth" }, async ({ browser }) => {
  const { admin } = await tenantWithExecutive(browser, "acctco", "계정주식회사");
  const c = clickCounter();
  // The signed-in name in the top bar opens My account.
  await c.click(admin.getByRole("banner").locator('a[href="/account"]'));
  await expect(admin.getByRole("heading", { name: "내 계정", level: 1 })).toBeVisible();
  // Switching the language loads that locale's screen copy before the page re-renders in it.
  // The whole screen re-renders in the new language; focus stays on the language control (keyboard and screen-reader users keep their place).
  await admin.getByRole("main").getByLabel("언어").selectOption("en");
  await expect(admin.getByRole("heading", { name: "My account", level: 1 })).toBeVisible();
  await expect(admin.getByRole("heading", { name: "Passkeys" })).toBeVisible();
  await expect(admin.getByRole("main").getByLabel("Language")).toBeFocused();
  await admin.getByRole("banner").getByLabel("Language").selectOption("ko");
  await expect(admin.getByRole("heading", { name: "내 계정", level: 1 })).toBeVisible();
  await expect(admin.getByRole("banner").getByLabel("언어")).toBeFocused();
  const main = admin.getByRole("main");
  // Decision #3: enrollment records no inferred privacy consent; legacy consent history stays read-only.
  await expect(main.getByText("직원 기록과 연결되지 않은 계정입니다")).toBeVisible();
  await expect(main.getByText(/개인정보 처리 고지 \S+/)).toBeVisible();
  await expect(main.getByText(/동의함$/)).toBeVisible();
  await expect(main.getByRole("checkbox")).toHaveCount(0);
  await expect(main.getByRole("button", { name: "이 기기에서 로그아웃" })).toHaveAccessibleName("이 기기에서 로그아웃");
  const passkeys = admin.getByRole("table", { name: "패스키" });
  await expect(passkeys.getByRole("row")).toHaveCount(2); // header + the enrolled passkey
  await expect(main.getByText(/공급사에 본인 확인 후 운영 계정 복구를 요청하고 대기 기간을 거쳐야 합니다/)).toHaveCount(1);
  // Passkeys have no stored name: each is named by its registration day.
  const only = passkeys.getByRole("button", { name: /등록 패스키 삭제$/ });
  // The last passkey's removal stays focusable and says why, with the way out next to it.
  await expect(only).toHaveAttribute("aria-disabled", "true");
  await expect(only).toHaveAccessibleDescription("마지막 패스키는 삭제할 수 없습니다");
  await only.focus();
  await admin.keyboard.press("Enter");
  await expect(admin.getByRole("dialog")).toHaveCount(0);
  await passkeys.getByRole("button", { name: "새 패스키 등록", exact: true }).click();
  const addButton = main.getByRole("button", { name: "패스키로 확인하고 새 패스키 등록" });
  await expect(addButton).toBeFocused();
  await expectAccessible(admin, "my account");

  // The step-up assertion uses the first passkey; the new one is created on a second device (the
  // first authenticator already holds this account's credential, which the server excludes).
  const first = authenticatorOf(admin);
  await admin.route("**/api/v1/auth/passkey/register/start", async (route) => {
    await first.remove();
    await virtualAuthenticator(admin);
    await route.continue();
  });
  await c.click(addButton);
  await expect(passkeys.getByRole("row")).toHaveCount(3);
  // A receipt, not just a refreshed list: focus lands on it.
  await expect(admin.locator("#acct-passkey-receipt")).toBeFocused();
  await expect(main.getByRole("status").filter({ hasText: "새 패스키를 등록했습니다" })).toBeVisible();
  // Two passkeys added the same day are numbered within that day.
  await expect(passkeys.getByRole("button", { name: /등록 패스키 1 삭제$/ })).toBeEnabled();
  await expect(passkeys.getByRole("button", { name: /등록 패스키 2 삭제$/ })).toBeEnabled();
  expect(c.done("add a second passkey")).toBeLessThanOrEqual(2);
  await admin.unroute("**/api/v1/auth/passkey/register/start");

  // Only the new device is present now: signing in proves the new passkey works.
  await main.getByRole("button", { name: "이 기기에서 로그아웃" }).click();
  await expect(admin).toHaveURL(/\/login/);
  await passkeyLogin(admin);

  await go(admin, "/account");
  // The new passkey signed in last: it carries 「최근 사용」, so the oldest is the one to remove.
  await expect(passkeys.getByRole("row").nth(2)).toContainText("최근 사용");
  const oldest = passkeys.getByRole("button", { name: /등록 패스키 1 삭제$/ });
  await c.click(oldest);
  const dialog = admin.getByRole("dialog", { name: /등록 패스키 1 삭제$/ });
  await expect(dialog).toContainText("더 이상 로그인할 수 없고");
  await expect(dialog).not.toContainText("방금 쓴 패스키");
  await expectAccessible(admin, "remove passkey dialog");
  // Removal first asserts my own (remaining) passkey: the server deletes nothing without that step-up.
  const stepUp = admin.waitForResponse((r) => r.url().endsWith("/api/v1/auth/passkey/login/start"));
  const removal = admin.waitForResponse((r) => r.request().method() === "DELETE" && r.url().includes("/api/v1/auth/passkeys/"));
  await c.click(dialog.getByRole("button", { name: /^패스키로 확인하고 .+ 등록 패스키 1 삭제$/ }));
  expect((await stepUp).ok()).toBe(true);
  expect((await removal).ok()).toBe(true);
  await expect(passkeys.getByRole("row")).toHaveCount(2);
  // The survivor is now alone on its day: no number, and its removal says why it cannot go.
  await expect(passkeys.getByRole("button", { name: /등록 패스키 삭제$/ })).toHaveAttribute("aria-disabled", "true");
  // The removed row cannot hold focus: the receipt naming what was removed does.
  await expect(admin.locator("#acct-passkey-receipt")).toBeFocused();
  await expect(main.getByRole("status").filter({ hasText: /패스키를 삭제했습니다 · .+ 등록 패스키 1/ })).toBeVisible();
  expect(c.done("remove a passkey")).toBeLessThanOrEqual(2);

  await admin.setViewportSize({ width: 390, height: 844 });
  await fits(admin, "my account");
});

test("a failed account-facts read keeps the passkeys and never invents HR recovery advice for an ops account", { tag: ["@auth", "@regression"] }, async ({ browser }) => {
  const admin = await openTenant(browser, "acct-facts-unavailable", "계정사실실패");
  await admin.route("**/api/v1/users/me", (route) => route.fulfill({
    status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "unavailable", message: "service temporarily unavailable" } }),
  }));
  await admin.goto("/account");
  await expect(admin.getByRole("region", { name: "프로필" }).getByText("불러오지 못했습니다", { exact: true })).toBeVisible({ timeout: 15_000 }); // wait for the read's retry backoff to finish
  const keys = admin.getByRole("region", { name: "패스키", exact: true });
  await expect(keys.getByRole("table").getByRole("row")).toHaveCount(2);
  await expect(keys.getByText(/권한 관리 담당자에게 로그인 코드를 다시 받아야/)).toHaveCount(0);
  await expect(keys.getByRole("button", { name: /등록 패스키 삭제$/ })).toHaveAttribute("aria-disabled", "true");
  await expectAccessible(admin, "my account: account facts unavailable");
});

// The vendor's account is a platform token: no employee link to read (that read answers 404 there), never an error.
test("my account for the platform vendor shows its tier, passkey and consent without an employee row", { tag: "@auth" }, async ({ browser }) => {
  const vendor = await vendorPage(browser);
  await go(vendor, "/account");
  const main = vendor.getByRole("main");
  await expect(main.getByRole("heading", { name: "내 계정", level: 1 })).toBeVisible();
  await expect(main.getByText("플랫폼 운영")).toBeVisible();
  await expect(main.getByText("소속", { exact: true })).toHaveCount(0);
  await expect(main.getByText(/개인정보 처리 고지 \S+/)).toBeVisible();
  await expect(main.getByRole("table", { name: "패스키" }).getByRole("button", { name: /등록 패스키 삭제$/ })).toHaveAttribute("aria-disabled", "true");
  await expect(vendor.getByRole("alert")).toHaveCount(0);
  await expectAccessible(vendor, "my account (vendor)");
});

// Enrollment registers the passkey, then signs in with it; when that sign-in is refused (429), the
// login screen says the passkey is registered and its passkey sign-in completes the start.
test("a refused sign-in right after enrollment lands on the login screen, and the new passkey signs in", { tag: "@auth" }, async ({ browser }) => {
  const { admin } = await tenantWithExecutive(browser, "enrollco", "등록실패주식회사");
  const code = await inviteAccount(admin, "김신입", "oversight");
  const page = await (await newContext(browser)).newPage();
  await virtualAuthenticator(page);
  let refused = false;
  await page.route("**/api/v1/auth/passkey/login/finish", (route) => {
    if (refused) return route.continue();
    refused = true;
    return route.fulfill({ status: 429, contentType: "application/json", body: JSON.stringify({ error: { code: "rate_limited", message: "too many sign-ins" } }) });
  });
  await page.goto("/login");
  await page.getByLabel("일회용 코드").fill(code);
  await page.getByRole("button", { name: "코드로 로그인" }).click();
  await acceptConsent(page);
  const agree = page.getByRole("button", { name: /동의하고 패스키 등록|패스키 등록/ });
  await expect(agree).toBeVisible();
  await agree.click();
  // A next step, not an error: announced as a status, with no alert.
  await expect(page.getByRole("status").filter({ hasText: "패스키를 등록했지만 이어서 로그인하지 못했습니다" })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page).toHaveURL(/\/login\?enrolled=true/);
  await expectAccessible(page, "login after a refused post-enrollment sign-in");
  await passkeyLogin(page);
  await expect(page.getByRole("heading", { name: "김신입님" })).toBeVisible();
});
