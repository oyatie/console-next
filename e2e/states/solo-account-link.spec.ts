// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test, type Page } from "@playwright/test";
import { i18n, loadCatalog, t } from "@console/i18n";
import { expectAxe, fits } from "../a11y";
import { authz, failure, id, user } from "../mock/fixtures";
import { mockLifecycleSheets, moveDetail } from "../mock/lifecycle-sheets";
import { mockRoute } from "../mock/route";
import { mockScreen } from "../mock/screen";
import { lifecycleSheetScreens } from "./lifecycle-sheets";
import { screens } from "./registry";

const binding = { action_kind: "EXCEPTION_DECIDE" as const, object_id: user.id,
  reason_key: "passkey_step_up_exception_decide" as const, replay_attempt: null, payload_hash: "a".repeat(64) };
const prepare = "/api/v1/users/me/employee-link/prepare";
const command = "/api/v1/users/me/employee-link";

async function openRecord(page: Page, reload = false) {
  const offer = page.waitForResponse(response => new URL(response.url()).pathname === prepare && response.request().method() === "POST");
  if (reload) await page.reload();
  else await page.goto(`/people/${moveDetail.employee.id}?tab=access`);
  await offer;
}

async function setup(page: Page, locale: "ko" | "en", offered = true) {
  await loadCatalog(locale); i18n.set(locale);
  await page.addInitScript(value => localStorage.setItem("console.locale", value), locale);
  const fixture = await mockScreen(page, screens[1], "populated");
  await mockLifecycleSheets(page, lifecycleSheetScreens[0]);
  await mockRoute(page, "get", "/api/v1/users/me", { status: 200, json: { ...user, display_name: moveDetail.employee.name } });
  await mockRoute(page, "get", "/api/v1/me/authz", { status: 200, json: { ...authz,
    capabilities: [...authz.capabilities, ...["user_manage", "employee_directory_manage"].map(feature => ({
      feature, permission: "allow" as const, branch_scope: { kind: "all" as const }, org_wide: true, scoped: false,
    }))],
  } });
  await mockRoute(page, "get", "/api/v1/directory/people", { status: 200, json: { items: [], total: 0, limit: 20, offset: 0 } });
  await mockRoute(page, "post", prepare, offered ? { status: 200, json: binding } : { status: 403, json: failure("account_link.refuse.solo_ineligible") });
  await mockRoute(page, "post", "/api/v1/auth/passkey/step-up/start", request => {
    if (request.postDataJSON()?.binding) expect(request.postDataJSON()).toEqual({ binding });
    return { status: 200, json: { ceremony_id: id(7000), expires_at: "2099-01-01T00:00:00Z", binding,
      challenge: { publicKey: { challenge: "dGVzdA", rpId: "localhost" } } } };
  });
  await mockRoute(page, "post", "/api/v1/auth/passkey/login/start", { status: 200, json: {
    ceremony_id: id(7000), expires_at: "2099-01-01T00:00:00Z",
    challenge: { publicKey: { challenge: "dGVzdA", rpId: "localhost" } },
  } });
  await page.addInitScript(() => Object.defineProperty(navigator.credentials, "get", {
    value: async () => ({ toJSON: () => ({ id: "test-passkey", type: "public-key" }) }),
  }));
  return fixture;
}

for (const locale of ["ko", "en"] as const) {
  test(`own account binding uses the server offer and command-bound passkey in ${locale} @ui-state`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    const fixture = await setup(page, locale);
    let writes = 0;
    await mockRoute(page, "post", command, request => {
      writes++;
      expect(request.postDataJSON()).toEqual({ employee_id: moveDetail.employee.id, step_up: {
        binding, assertion: { ceremony_id: id(7000), credential: { id: "test-passkey", type: "public-key" } },
      } });
      return { status: 201, json: { attestation_id: id(7000) } };
    });
    await openRecord(page);
    const button = page.getByRole("button", { name: locale === "ko" ? "내 계정 연결" : "Link my account", exact: true });
    await expect(button).toHaveCount(1);
    await expect(page.getByRole("region", { name: t("people.account.title"), exact: true }).getByRole("combobox")).toHaveCount(0);
    for (const theme of ["light", "dark"]) {
      await page.locator("html").evaluate((element, value) => { element.dataset.theme = value; }, theme);
      await fits(page, `own-account/${locale}/${theme}`);
      await expectAxe(page, `own-account/${locale}/${theme}`);
      await page.screenshot({ path: test.info().outputPath(`${theme}.png`), fullPage: true });
    }
    await button.click();
    await expect.poll(() => writes).toBe(1);
    expect(fixture.unexpected).toEqual([]);
  });

  for (const [code, status] of [
    ["account_link.refuse.solo_ineligible", 403], ["account_link.refuse.employee_taken", 409],
    ["account_link.refuse.not_own_record", 403], ["account_link.refuse.withdraw_ineligible", 403],
    ["step_up_failed", 403], ["step_up_required", 428],
  ] as const) test(`own account binding renders ${code} in ${locale} @ui-state`, async ({ page }) => {
    const fixture = await setup(page, locale);
    const withdrawing = code === "account_link.refuse.withdraw_ineligible";
    await mockRoute(page, "post", command, withdrawing ? { status: 201, json: { attestation_id: id(7000) } }
      : { status, json: { error: { code, message: "" } } });
    if (withdrawing) await mockRoute(page, "post", "/api/v1/users/me/employee-link/withdraw", { status, json: { error: { code, message: "" } } });
    await openRecord(page);
    await page.getByRole("button", { name: locale === "ko" ? "내 계정 연결" : "Link my account", exact: true }).click();
    if (withdrawing) await page.getByRole("button", { name: t("uiOverrideSheet.stepUp", { action: t("people.account.withdrawOwn") }), exact: true }).click();
    const alert = page.getByRole("alert");
    await expect(alert).toBeVisible();
    if (code.startsWith("account_link.")) {
      const copy = t(code as "account_link.refuse.solo_ineligible");
      expect(copy).not.toBe(code);
      await expect(alert).toContainText(copy);
    }
    else await expect(alert).toContainText(code === "step_up_failed" ? t("accounts.code.step_up_failed") : t("accounts.code.step_up_required"));
    expect(fixture.unexpected).toEqual([]);
  });
}

test("another eligible person prevents the own-account offer @ui-state", async ({ page }) => {
  const fixture = await setup(page, "ko", false);
  await openRecord(page);
  await expect(page.getByRole("region", { name: "로그인 계정", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "내 계정 연결", exact: true })).toHaveCount(0);
  await mockRoute(page, "post", prepare, { status: 200, json: binding });
  await openRecord(page, true);
  await expect(page.getByRole("button", { name: "내 계정 연결", exact: true })).toHaveCount(1);
  expect(fixture.unexpected).toEqual([]);
});

for (const locale of ["ko", "en"] as const) {
  test(`own-account receipt offers a passkey withdrawal in ${locale} @ui-state`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    await setup(page, locale);
    let linked = false;
    await mockRoute(page, "get", "/api/v1/directory/people", () => ({ status: 200, json: {
      items: linked ? [{ ...user, display_name: moveDetail.employee.name, employee_id: moveDetail.employee.id, employee_link_status: "LINKED" as const }] : [],
      total: linked ? 1 : 0, limit: 20, offset: 0,
    } }));
    await mockRoute(page, "post", command, () => {
      linked = true;
      return { status: 201, json: { attestation_id: id(7000) } };
    });
    let withdrawals = 0;
    await mockRoute(page, "post", "/api/v1/users/me/employee-link/withdraw", request => {
      expect(request.postDataJSON().attestation_id).toBe(id(7000));
      expect(request.postDataJSON().step_up.ceremony_id).toBe(id(7000));
      withdrawals++;
      linked = false;
      return { status: 200, json: {} };
    });
    await openRecord(page);
    await page.getByRole("button", { name: t("people.account.ownLink"), exact: true }).click();
    await expect(page.getByText(t("people.account.selfAttested"), { exact: true })).toBeVisible();
    const withdraw = page.getByRole("button", { name: t("uiOverrideSheet.stepUp", { action: t("people.account.withdrawOwn") }), exact: true });
    for (const theme of ["light", "dark"]) {
      await page.locator("html").evaluate((element, value) => { element.dataset.theme = value; }, theme);
      await fits(page, `self-attested/${locale}/${theme}`);
      await expectAxe(page, `self-attested/${locale}/${theme}`);
      await page.screenshot({ path: test.info().outputPath(`${theme}.png`), fullPage: true });
    }
    await withdraw.click();
    await expect.poll(() => withdrawals).toBe(1);
    await expect(page.getByRole("button", { name: t("people.account.ownLink"), exact: true })).toBeVisible();
  });
}
