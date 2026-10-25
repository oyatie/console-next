// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { acceptConsent, firstSignIn, newContext, takeCode, tenantSlugField, unique, vendorPage, go } from "./flows";
import { virtualAuthenticator } from "./auth";

// PV1: Privacy notice and consent before the first personal-data field (P0)
// On first sign-in the privacy notice is shown and acknowledged before any personal-data field renders.
// Commit is disabled until both [필수] items are checked. First visit shows no false error.

test("on /setup-passkey no personal-data input exists until notice acknowledged and both [필수] items checked", { tag: "@privacy" }, async ({ browser }) => {
  const companyDomain = unique("pvsol");
  const v = await vendorPage(browser);
  await go(v, "/platform");
  await v.getByRole("button", { name: "고객 계정 개설" }).click();
  await v.getByLabel("고객 이름").fill("개인정보테스트");
  await tenantSlugField(v).fill(companyDomain);
  await v.getByRole("button", { name: "개설하고 코드 발급" }).click();
  const code = await takeCode(v);

  const page = await (await newContext(browser)).newPage();
  await virtualAuthenticator(page);
  await go(page, "/login");

  // False error regression check (#44): fresh visit shows no error banner
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.locator(".banner--danger, [role='alert']")).toHaveCount(0);

  // Enter one-time code to reach enrollment screen
  await page.getByLabel("일회용 코드").fill(code);
  const documentResponse = page.waitForResponse((response) => response.url().endsWith("/api/v1/onboarding/terms") && response.request().method() === "GET");
  await page.getByRole("button", { name: "코드로 로그인" }).click();
  const documents = await (await documentResponse).json();

  // On /setup-passkey
  await page.waitForURL(/\/setup-passkey/);

  // 1. Commit button is disabled until both required checkboxes are checked
  const commit = page.getByRole("button", { name: /패스키 등록/ });
  await expect(commit).toBeVisible();
  await expect(commit).toBeDisabled();

  // 2. Both [필수] consent items exist and start unchecked
  const checkboxes = page.getByRole("checkbox");
  await expect(checkboxes).toHaveCount(2);

  const privacyCheck = page.getByRole("checkbox", { name: /개인정보 수집·이용/ });
  const termsCheck = page.getByRole("checkbox", { name: /서비스 이용약관/ });
  await expect(privacyCheck).toBeVisible();
  await expect(termsCheck).toBeVisible();
  await expect(privacyCheck).not.toBeChecked();
  await expect(termsCheck).not.toBeChecked();

  // 3. Policy URL appears as plain text until WEB-PRIVACY #17 publishes
  await expect(page.getByText("https://cosskorea.com/privacy")).toBeVisible();

  // 4. No personal data inputs exist in the DOM
  await expect(page.getByLabel(/^이름/)).toHaveCount(0);
  await expect(page.getByLabel(/주민등록번호/)).toHaveCount(0);
  await expect(page.getByLabel(/생년월일/)).toHaveCount(0);
  await expect(page.getByLabel(/전화번호/)).toHaveCount(0);

  // The disclosed texts match the versioned store, and opening them never changes checkbox names.
  expect(documents.privacy.body).not.toMatch(/게시 전|<a id=|【|privacy-policy-facts|console-next/);
  const disclosures = page.locator("details");
  await disclosures.nth(0).locator("summary").click();
  await expect(disclosures.nth(0).locator("p")).toHaveText(documents.privacy.body);
  await disclosures.nth(1).locator("summary").click();
  await expect(disclosures.nth(1).locator("p")).toHaveText(documents.body);
  await expect(privacyCheck).toHaveAccessibleName("[필수] 개인정보 수집·이용");
  await expect(termsCheck).toHaveAccessibleName("[필수] 서비스 이용약관");
  await expect(page.getByLabel(/전화번호/)).toHaveCount(0);

  // 5. Checking only one box keeps commit disabled
  await expect(privacyCheck).toBeEnabled();
  await privacyCheck.press("Space");
  await expect(commit).toBeDisabled();

  // 6. Checking both enables the commit button
  await expect(termsCheck).toBeEnabled();
  await termsCheck.press("Space");
  await expect(commit).toBeEnabled();

  // An N-1 request must receive a typed review refusal, then recover with both displayed references.
  await page.route("**/api/v1/auth/privacy-consent/accept", async (route) => {
    expect(route.request().postDataJSON()).toMatchObject({
      privacy: { version: documents.privacy.version, sha256: documents.privacy.sha256 },
      terms: { version: documents.version, sha256: documents.sha256 },
    });
    const response = await route.fetch({ postData: {
      policy_version: "kr-pipa-v1-2026-06-25", privacy_collection: true, terms_of_service: true,
    } });
    expect(response.status()).toBe(409);
    expect((await response.json()).error.code).toBe("terms_text_changed");
    const status = await page.request.post("/api/v1/auth/privacy-consent/status", {
      headers: { authorization: route.request().headers().authorization! }, data: {},
    });
    expect(status.ok()).toBe(true);
    expect((await status.json()).accepted).toBe(false);
    await route.fulfill({ response });
  }, { times: 1 });
  const refused = page.waitForResponse((response) => response.url().endsWith("/api/v1/auth/privacy-consent/accept") && response.status() === 409);
  await commit.click();
  await refused;
  await expect(commit).toBeEnabled();
  const accepted = page.waitForResponse((response) => response.url().endsWith("/api/v1/auth/privacy-consent/accept") && response.status() === 200);
  await commit.click();
  await accepted;
  await expect(page.getByRole("button", { name: "로그아웃" })).toBeVisible();
});

test("fresh sign-in shows no false error on first visit (issue #44 regression)", { tag: "@privacy" }, async ({ browser }) => {
  const page = await (await newContext(browser)).newPage();
  await page.addInitScript(() => {
    Object.defineProperty(PublicKeyCredential, "isConditionalMediationAvailable", { value: async () => true });
  });
  await page.route("**/api/v1/auth/passkey/login/start", (route) => route.fulfill({
    status: 429, contentType: "application/json", body: JSON.stringify({ error: { code: "rate_limited", message: "Rate limited" } }),
  }));
  const refused = page.waitForResponse((response) => response.url().endsWith("/api/v1/auth/passkey/login/start") && response.status() === 429);
  await page.goto("/login");
  await refused;
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByLabel("일회용 코드")).toBeVisible();

  // Must not display any error banner
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByText("패스키 인증을 완료하지 못했습니다")).toHaveCount(0);
});

test("unpublished consent documents show operator action and allow sign out", { tag: "@privacy" }, async ({ browser }) => {
  const v = await vendorPage(browser);
  await go(v, "/platform");
  await v.getByRole("button", { name: "고객 계정 개설" }).click();
  await v.getByLabel("고객 이름").fill("개인정보미공개테스트");
  await tenantSlugField(v).fill(unique("pvunpublished"));
  await v.getByRole("button", { name: "개설하고 코드 발급" }).click();
  const page = await firstSignIn(browser, await takeCode(v));
  const unavailable = { status: 409, contentType: "application/json", body: JSON.stringify({ error: { code: "terms_not_published", message: "No terms published" } }) };
  try {
    await page.addInitScript(() => {
      const fetch = window.fetch;
      window.fetch = async (...args) => {
        const response = await fetch(...args);
        if (new URL(response.url).pathname !== "/api/v1/auth/token/refresh" || !response.ok) return response;
        return new Response(JSON.stringify({ ...await response.json(), privacy_consent_accepted: false }), { status: response.status, headers: response.headers });
      };
    });
    await page.route("**/api/v1/onboarding/terms", (route) => route.fulfill(unavailable));
    await page.goto("/people");
    await expect(page).toHaveURL(/\/setup-passkey/);
    await expect(page.getByRole("alert")).toContainText("공개된 이용약관이 없습니다. 운영사에 문의하십시오.");
    await expect(page.getByRole("button", { name: "동의하고 계속" })).toBeDisabled();
    await page.getByRole("button", { name: "로그아웃" }).click();
    await expect(page).toHaveURL(/\/login/);
  } finally {
    await page.unrouteAll({ behavior: "wait" });
  }
});


test("ten in-app navigations make no consent requests after first sign-in", { tag: "@privacy" }, async ({ browser }) => {
  const vendor = await vendorPage(browser);
  await go(vendor, "/platform");
  await vendor.getByRole("button", { name: "고객 계정 개설" }).click();
  await vendor.getByLabel("고객 이름").fill("동의 세션 테스트");
  await tenantSlugField(vendor).fill(unique("pvsession"));
  await vendor.getByRole("button", { name: "개설하고 코드 발급" }).click();
  const page = await firstSignIn(browser, await takeCode(vendor));
  const consentRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/v1/auth/privacy-consent/")) consentRequests.push(request.url());
  });
  for (let i = 0; i < 10; i++) {
    const entities = i % 2 === 0;
    await go(page, entities ? "/org/entities" : "/settings/company-domain");
    if (entities) await expect(page.locator("#entities-title")).toBeVisible();
    else await expect(page.getByRole("heading", { name: "회사 도메인", exact: true }).first()).toBeVisible();
  }
  expect(consentRequests).toEqual([]);
  await page.reload();
  await expect(page.getByRole("heading", { name: "회사 도메인", exact: true }).first()).toBeVisible();
  expect(consentRequests).toEqual([]);

  // The shared transport also catches a missed publication hint, without a reload or an automatic replay.
  await page.route("**/api/v1/legal-entities", (route) => route.fulfill({ status: 403, contentType: "application/json", json: { error: { code: "privacy_consent_required", message: "Review current documents" } } }), { times: 1 });
  await go(page, "/org/entities?add=true#entities-title", true);
  await expect(page).toHaveURL(/\/setup-passkey$/);
  await acceptConsent(page);
  await page.getByRole("button", { name: "동의하고 계속", exact: true }).click();
  await expect(page).toHaveURL(/\/org\/entities\?add=true#entities-title$/);
  await expect(page.locator("#entities-title")).toBeVisible();
  await expect(page.getByRole("heading", { name: "이 화면에 접근 권한이 없습니다", exact: true })).toHaveCount(0);
});
