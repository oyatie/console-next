import { expect, test, type Browser, type Page } from "@playwright/test";
import { josa } from "@console/i18n";
import { expectAccessible } from "./a11y";
import { authenticatorOf, virtualAuthenticator } from "./auth";
import { tenantSlugField, firstSignIn, go, newContext, option, stepUp, takeCode, unique, vendorPage } from "./flows";

// AUTH-ID (decisions #33; docs/design/sign-in-identifier.md): the sign-in ID 아이디@도메인. It is handed over with the
// one-time code; identifier-first sign-in names the account's passkeys (a security key without a resident credential
// signs in and confirms); the 「패스키로 로그인」 button stays usernameless; the field's autofill signs in on load; an
// unknown ID reads exactly like "no passkey here"; a rename keeps the old ID signing in, and the history shows both.

const NO_PASSKEY = "이 기기에서 쓸 수 있는 패스키가 없습니다";
const signedIn = (page: Page) => expect(page.getByRole("button", { name: "로그아웃" }).first()).toBeVisible();
const signOut = async (page: Page) => (await page.getByRole("button", { name: "로그아웃" }).first().click(), expect(page).toHaveURL(/\/login$/));
const idField = (page: Page) => page.getByRole("textbox", { name: "아이디" });

/** A fresh tenant and its admin; the domain is its slug. */
async function tenant(browser: Browser, slug: string) {
  const domain = unique(slug);
  const v = await vendorPage(browser);
  await go(v, "/platform");
  await v.getByRole("button", { name: "고객 계정 개설" }).click();
  await v.getByLabel("고객 이름").fill(`${slug} 고객`);
  await tenantSlugField(v).fill(domain);
  await v.getByRole("button", { name: "개설하고 코드 발급" }).click();
  return { admin: await firstSignIn(browser, await takeCode(v)), domain };
}

/** Invites someone who is not an employee with the 아이디 typed in; returns their code and full sign-in ID. */
async function invite(admin: Page, name: string, login: string, audit = false) {
  await go(admin, "/people?view=accounts");
  await admin.getByRole("button", { name: "계정 초대" }).click();
  const sheet = admin.getByRole("dialog", { name: "계정 초대" });
  await sheet.getByRole("button", { name: "직원이 아닌 사람 초대" }).click();
  await sheet.getByRole("textbox", { name: /^이름/ }).fill(name);
  const id = sheet.getByRole("textbox", { name: /^아이디/ });
  await id.fill("홍");
  await sheet.getByRole("button", { name: "패스키로 확인하고 계정 초대" }).click();
  await expect(sheet).toContainText("한글이나 전각 문자는 쓸 수 없습니다");
  await id.fill(login);
  if (audit) await expectAccessible(admin, "invite sheet with a sign-in ID");
  await stepUp(sheet, "패스키로 확인하고 계정 초대", admin.getByLabel("일회용 코드"));
  const signInId = (await admin.getByRole("dialog").locator("dl .code").textContent())!.trim();
  return { code: await takeCode(admin), signInId };
}

/** Sign-in by ID, proving the request named it (the autofill is paused after a sign-out, so it cannot race). */
async function signInById(page: Page, id: string) {
  const named = page.waitForRequest((r) => r.url().endsWith("/api/v1/auth/passkey/login/start") && (r.postData() ?? "").includes(`"identifier":"${id}"`));
  await idField(page).fill(id);
  await page.getByRole("button", { name: "계속" }).click();
  await named;
}

test("sign-in ID: handed over with the code, identifier-first, the button, autofill, and unknown IDs read as no passkey", async ({ browser, browserName }) => {
  const { admin, domain } = await tenant(browser, "signinid");
  const { code, signInId } = await invite(admin, "김아이디", "kim.id", true);
  expect(signInId).toBe(`kim.id@${domain}`);
  // A real account that has no passkey yet: it must read exactly like an unknown ID.
  await invite(admin, "박대기", "park.waiting");
  const kim = await firstSignIn(browser, code);

  // Identifier first.
  await signOut(kim);
  await expect(idField(kim)).toHaveAttribute("autocomplete", "username webauthn");
  await expectAccessible(kim, "sign-in with the sign-in ID field");
  await signInById(kim, signInId);
  await signedIn(kim);

  // The usernameless button.
  await signOut(kim);
  await kim.getByRole("button", { name: "패스키로 로그인" }).click();
  await signedIn(kim);

  // A bare 아이디 is completed from the domain this browser signed into; an unknown one reads as no passkey here.
  await signOut(kim);
  await idField(kim).fill("kim.id");
  await kim.getByRole("button", { name: "계속" }).click();
  await signedIn(kim);
  await signOut(kim);
  for (const other of [`nobody.here@${domain}`, `nobody.here@no-such-${domain}`, `park.waiting@${domain}`]) {
    await signInById(kim, other);
    await expect(kim.getByRole("status").filter({ hasText: NO_PASSKEY })).toBeVisible();
    await expect(kim.getByRole("alert")).toHaveCount(0);
  }
  await idField(kim).fill("ho..ng@acme");
  await kim.getByRole("button", { name: "계속" }).click();
  await expect(kim.getByText("기호로 시작하거나 끝나거나 연달아 쓸 수 없습니다")).toBeVisible();

  // Autofill: a new page, the same passkey, nobody pressing anything. Chromium's virtual authenticator answers a
  // conditional request at once; Playwright's Firefox credentials only answer a modal one, so there the field offers it.
  const page = await (await newContext(browser)).newPage();
  await (await virtualAuthenticator(page)).import(await authenticatorOf(kim).export());
  await page.goto("/login");
  if (browserName === "chromium") await signedIn(page);
  else await expect(idField(page)).toHaveAttribute("autocomplete", "username webauthn");
  await page.context().close();
});

test("sign-in ID: a rename keeps the old ID signing in, the history shows both, and an old ID is never reissued", async ({ browser }) => {
  const { admin, domain } = await tenant(browser, "renameid");
  const { code } = await invite(admin, "이개명", "lee.old");
  const lee = await firstSignIn(browser, code);

  await go(admin, "/people?view=accounts");
  await admin.getByRole("row", { name: /이개명/ }).click();
  const panel = admin.getByRole("complementary", { name: "이개명" });
  await expect(panel).toContainText(`lee.old@${domain}`);
  await panel.getByRole("button", { name: "아이디 변경" }).click();
  await expect(panel.getByRole("textbox", { name: /^새 아이디/ })).toHaveAccessibleDescription("영문 소문자·숫자·._- · 1–32자");
  await expect(panel.getByText("이전 아이디는 90일 동안 로그인할 수 있고, 계속 검색되며 다시 배정되지 않습니다.", { exact: true })).toBeVisible();
  await panel.getByRole("textbox", { name: /^새 아이디/ }).fill("lee.new");
  await option(admin, "변경 사유", "개명").click();
  // the list re-lays out while the invite's panel settles (accounts.spec judges that screen); only the form's
  // own stability is this spec's subject, so earlier shifts are dropped here.
  await admin.evaluate(() => void window.__shifts?.splice(0));
  await expectAccessible(admin, "sign-in ID change form");
  await panel.getByRole("button", { name: "아이디 저장" }).click();
  await expect(panel.getByRole("status")).toContainText(`이개명님의 아이디를 ${josa(`lee.new@${domain}`, "으로로")} 변경했습니다`);
  await panel.getByRole("button", { name: "아이디 이력" }).click();
  const history = panel.getByRole("table", { name: "아이디 이력" });
  await expect(history.getByRole("row", { name: new RegExp(`lee.new@${domain}.*현재`) })).toBeVisible();
  await expect(history.getByRole("row", { name: new RegExp(`lee.old@${domain}.*까지 로그인 가능`) })).toBeVisible();
  await expectAccessible(admin, "sign-in ID history");

  // The old ID is never given out again, to anyone.
  const reuse = await (async () => {
    await admin.getByRole("button", { name: "계정 초대" }).click();
    const sheet = admin.getByRole("dialog", { name: "계정 초대" });
    await sheet.getByRole("button", { name: "직원이 아닌 사람 초대" }).click();
    await sheet.getByRole("textbox", { name: /^이름/ }).fill("박재사용");
    await sheet.getByRole("textbox", { name: /^아이디/ }).fill("lee.old");
    await sheet.getByRole("button", { name: "패스키로 확인하고 계정 초대" }).click();
    return sheet;
  })();
  await expect(reuse).toContainText("한 번 쓰인 아이디는 누구에게도 다시 쓰이지 않습니다");

  // The renamed person signs in with the old ID (an alias for 90 days) and with the new one.
  await signOut(lee);
  await signInById(lee, `lee.old@${domain}`);
  await signedIn(lee);
  await signOut(lee);
  await signInById(lee, `lee.new@${domain}`);
  await signedIn(lee);
  await go(lee, "/account");
  await expect(lee.getByText(`lee.new@${domain}`)).toBeVisible();
});

/** Chromium's virtual security key with no resident-key storage: every credential it makes is server-side only. */
async function securityKey(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "usb", hasResidentKey: false, hasUserVerification: true, isUserVerified: true },
  });
}

test("sign-in ID: a security key without a resident credential enrols, signs in by ID and confirms a step-up", async ({ browser, browserName }) => {
  test.skip(browserName !== "chromium", "Playwright's Firefox credentials are always resident; only CDP models a security key");
  // The tenant's own admin enrols a security key, so the step-up below is a real governed action (an invite).
  const domain = unique("seckeyid");
  const v = await vendorPage(browser);
  await go(v, "/platform");
  await v.getByRole("button", { name: "고객 계정 개설" }).click();
  await v.getByLabel("고객 이름").fill("seckeyid 고객");
  await tenantSlugField(v).fill(domain);
  await v.getByRole("button", { name: "개설하고 코드 발급" }).click();
  const code = await takeCode(v);
  const page = await (await newContext(browser)).newPage();
  await securityKey(page);
  await page.goto("/login");
  await page.getByLabel("일회용 코드").fill(code);
  await page.getByRole("button", { name: "코드로 로그인" }).click();
  const enroll = page.getByRole("button", { name: "패스키 등록", exact: true });
  await expect(enroll).toBeVisible();
  await expect(page.getByRole("checkbox")).toHaveCount(0);
  // residentKey "preferred": the key keeps no resident credential, and the sign-in right after names it by ID.
  await enroll.click();
  await signedIn(page);
  await go(page, "/account");
  const signInId = (await page.locator("main").getByText(new RegExp(`@${domain}$`)).textContent())!.trim();

  // The usernameless button cannot find it; the ID can.
  await signOut(page);
  await page.getByRole("button", { name: "패스키로 로그인" }).click();
  await expect(page.getByRole("status").filter({ hasText: NO_PASSKEY })).toBeVisible();
  await signInById(page, signInId);
  await signedIn(page);

  // A step-up names the caller's own passkeys: the invite confirms with this key and issues the code.
  await invite(page, "정초대", "jung.invited");
});
