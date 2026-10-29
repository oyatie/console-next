// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { virtualAuthenticator } from "./auth";
import { inviteAccount } from "./access-flows";
import { acceptConsent, newContext, openCodeSignIn, vendorPage } from "./flows";
import { tenantBeforeSetup } from "./setup-flows";
import { clearShifts } from "./stability";

test("admin-issued code rejects replay while its winning session can finish enrollment", { tag: "@auth" }, async ({ browser }) => {
  const { admin, exec } = await tenantBeforeSetup(browser, "singleuse", "일회용코드상사", false, "none");
  const otp = await inviteAccount(admin, "한번사용", "none");
  const context = await newContext(browser);
  const page = await context.newPage();
  await virtualAuthenticator(page);
  await page.goto("/login");
  await openCodeSignIn(page);
  await page.getByLabel("일회용 코드").fill(otp);
  const signedIn = page.waitForResponse((response) => response.url().endsWith("/api/v1/auth/otp/redeem"));
  await page.getByRole("button", { name: "코드로 로그인" }).click();
  const response = await signedIn;
  expect(response.status()).toBe(200);
  expect(await response.json()).toMatchObject({ requires_passkey_setup: true, otp_reusable: false });
  for (const code of [otp, otp.replaceAll("-", "").toLowerCase()]) {
    const replay = await context.request.post("/api/v1/auth/otp/redeem", { data: { otp: code } });
    expect(replay.status()).toBe(401);
    expect(await replay.json()).toMatchObject({ error: { code: "unauthorized" } });
  }
  await acceptConsent(page);
  await page.getByRole("button", { name: /동의하고 패스키 등록|패스키 등록/, disabled: false }).click();
  await expect(page.getByRole("button", { name: "로그아웃" })).toBeVisible({ timeout: 20_000 });
  await context.close();
  await admin.context().close();
  await exec.context().close();
  // Tenant creation is setup for this auth check; do not carry its shifts into the shared vendor's next audit.
  await (await vendorPage(browser)).evaluate(clearShifts);
});
