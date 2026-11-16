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
  await mockRoute(page, "post", "/api/v1/auth/token/refresh", (screen.key === "login" || state === "refused")
    ? { status: 401, json: failure("unauthorized") }
    : { status: 200, json: { ...token(), privacy_consent_accepted: screen.key !== "setup-passkey" } });
  await page.route("**/api/v1/auth/logout", route => route.fulfill({ status: 204 }));
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let attempts = 0;
  const wait = async () => { attempts++; if (state === "loading" || state === "pending") await held; };
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

/** Keep the OS ceremony and its server verification independently controllable. */
export async function accountSecurityPasskey(page: Page, mode: "login" | "autofill" | "enroll" | "reauth") {
  const shell = await mockScreen(page, screens[0], "populated");
  await accountReads(page, "save-unchanged");
  const pair = token();
  if (mode === "enroll") {
    const claims = JSON.parse(Buffer.from(pair.access_token.split(".")[1]!, "base64url").toString());
    pair.access_token = `h.${Buffer.from(JSON.stringify({ ...claims, enrollment: true })).toString("base64url")}.s`;
    pair.requires_passkey_setup = true;
  }
  await mockRoute(page, "post", "/api/v1/auth/token/refresh", mode === "login" || mode === "autofill"
    ? { status: 401, json: failure("unauthorized") } : { status: 200, json: pair });
  await page.addInitScript(autofill => {
    class Credential {
      static isConditionalMediationAvailable = async () => autofill;
      static parseRequestOptionsFromJSON = (options: unknown) => options;
      static parseCreationOptionsFromJSON = (options: unknown) => options;
      toJSON() { return { id: "credential" }; }
    }
    Object.defineProperty(window, "PublicKeyCredential", { configurable: true, value: Credential });
    for (const method of ["get", "create"]) Object.defineProperty(navigator.credentials, method, { configurable: true, value: ({ signal }: CredentialRequestOptions = {}) => {
      document.documentElement.dataset.passkeySheet = method;
      return new Promise(resolve => {
        window.addEventListener("test-passkey-select", () => resolve(new Credential()), { once: true });
        signal?.addEventListener("abort", () => resolve(null), { once: true });
      });
    } });
  }, mode === "autofill");
  const ceremony = { ceremony_id: "test-ceremony", challenge: { publicKey: { challenge: "Y2hhbGxlbmdl" } }, expires_at: new Date(Date.now() + 300_000).toISOString() };
  await mockRoute(page, "post", "/api/v1/auth/passkey/login/start", { status: 200, json: ceremony });
  await mockRoute(page, "post", "/api/v1/auth/passkey/register/start", { status: 200, json: ceremony });
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let attempts = 0;
  await mockRoute(page, "post", "/api/v1/auth/passkey/login/finish", async () => {
    attempts++;
    await held;
    return { status: 401, json: failure("unauthorized") };
  });
  await mockRoute(page, "post", "/api/v1/auth/passkey/register/finish", async () => {
    attempts++;
    await held;
    return { status: 403, json: failure("forbidden") };
  });
  return { ...shell, attempts: () => attempts, release: () => { release(); shell.release(); } };
}
