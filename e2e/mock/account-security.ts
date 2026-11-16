// SPDX-License-Identifier: LicenseRef-Proprietary
import type { Page } from "@playwright/test";
import type { AccountSecurityScreen, AccountSecurityState } from "../states/account-security";
import { screens } from "../states/registry";
import { accountReads } from "./account";
import { failure, token } from "./fixtures";
import { mockRoute } from "./route";
import { mockScreen } from "./screen";

export async function accountSecurityReads(page: Page, screen: AccountSecurityScreen, state: AccountSecurityState) {
  const shell = await mockScreen(page, screens[0], "populated");
  await accountReads(page, "save-unchanged");
  // Only explicit sign-ins run: conditional WebAuthn availability differs between browsers.
  await page.addInitScript(() => Object.defineProperty(window, "PublicKeyCredential", { value: undefined }));
  await mockRoute(page, "post", "/api/v1/auth/token/refresh", screen.key === "login"
    ? { status: 401, json: failure("unauthorized") }
    : { status: 200, json: { ...token(), privacy_consent_accepted: screen.key !== "setup-passkey" } });
  await page.route("**/api/v1/auth/logout", route => route.fulfill({ status: 204 }));
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let attempts = 0;
  const wait = async () => { attempts++; if (state === "loading") await held; };
  // shortcut: OpenAPI omits the 409 ErrorBody, use mockRoute once the response schema is declared.
  if (screen.key === "setup-passkey") await page.route("**/api/v1/onboarding/terms", async route => {
    if (route.request().method() !== "GET") return route.fallback();
    await wait();
    if (!page.isClosed()) await route.fulfill({ status: 409, json: failure("terms_not_published") });
  });
  if (screen.key === "login") await mockRoute(page, "post", "/api/v1/auth/otp/redeem", async () => {
    await wait();
    return { status: 401, json: failure("unauthorized") };
  });
  return { ...shell, attempts: () => attempts, release: () => { release(); shell.release(); } };
}
