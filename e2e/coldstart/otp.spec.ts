// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { readDevSecrets } from "../../scripts/dev-secrets";
import { virtualAuthenticator } from "../auth";
import { acceptConsent, newContext, openCodeSignIn } from "../flows";

test("cold-start code rejects replay before its enrollment session finishes", async ({ browser }) => {
  const context = await newContext(browser);
  const page = await context.newPage();
  await virtualAuthenticator(page);
  await page.goto("/login");
  await openCodeSignIn(page);
  const otp = readDevSecrets().coldstartOtp;
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

  // Claiming the code must leave its original enrollment session usable.
  await acceptConsent(page);
  await page.getByRole("button", { name: /동의하고 패스키 등록|패스키 등록/, disabled: false }).click();
  await expect(page.getByRole("button", { name: "로그아웃" })).toBeVisible({ timeout: 20_000 });
  await context.close();
});
