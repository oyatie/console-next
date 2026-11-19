// SPDX-License-Identifier: LicenseRef-Proprietary
import { setTimeout as delay } from "node:timers/promises";
import { expect, test } from "@playwright/test";
import { bootKo } from "../packages/i18n/src/catalogs/boot";
import { passkeyLogin } from "./flows";
import { openTenant } from "./helpers/tenant";

const tags = { tag: ["@auth", "@journey:sign-in", "@tier:pr"] };

test("a refreshed signed-in session needs no passkey assertion", tags, async ({ browser }) => {
  const page = await openTenant(browser, "passkeyrefresh", "로그인 유지");
  const requests: string[] = [];
  page.on("request", request => {
    if (request.url().includes("/auth/passkey/login/")) requests.push(request.url());
  });
  await page.reload();
  await passkeyLogin(page);
  await expect(page.getByRole("button", { name: bootKo["shell.logout"], exact: true })).toBeVisible();
  expect(requests).toEqual([]);
});

test("passkey sign-in reports a missing sign-in screen or session", tags, async ({ page }) => {
  await expect(passkeyLogin(page)).rejects.toThrow("Expected the passkey sign-in button or signed-in shell");
});

test("an assertion already being verified completes sign-in exactly once", tags, async ({ browser }) => {
  const page = await openTenant(browser, "passkeyverify", "인증 확인");
  const logout = page.getByRole("button", { name: bootKo["shell.logout"], exact: true });
  await logout.click();
  const button = page.getByRole("button", { name: bootKo["auth.login.passkey"], exact: true });
  const finish = "**/api/v1/auth/passkey/login/finish";
  let assertions = 0;
  await page.route(finish, async route => {
    assertions++;
    // Model a slow verification response after the authenticator has already answered.
    await delay(6_000);
    await route.continue();
  });
  await Promise.all([page.waitForRequest(finish), button.click()]);
  await expect(button).toBeDisabled();
  await passkeyLogin(page);
  await expect(logout).toBeVisible();
  expect(assertions).toBe(1);
});
