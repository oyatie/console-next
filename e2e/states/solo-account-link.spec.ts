// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, type Page } from "@playwright/test";
import { test } from "../locale-fixture";
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

async function openRecord(page: Page, reload = false, linked = false) {
  const offer = page.waitForResponse(response => new URL(response.url()).pathname === (linked ? command : prepare) && response.request().method() === (linked ? "GET" : "POST"));
  if (reload) await page.reload();
  else await page.goto(`/people/${moveDetail.employee.id}?tab=access`);
  await offer;
}

async function setup(page: Page, locale: "ko" | "en", offered = true) {
  await loadCatalog(locale); i18n.set(locale);
  await page.addInitScript(value => localStorage.setItem("console.locale", value), locale);
  const fixture = await mockScreen(page, screens[1], "populated");
  await mockLifecycleSheets(page, lifecycleSheetScreens[0]);
  let receipt: { attestation_id: string; employee_id: string; can_withdraw: boolean } | null = null;
  await page.route(`**${command}`, route => route.request().method() === "GET"
    ? route.fulfill({ json: { attestation: receipt } }) : route.fallback());
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
  return { ...fixture, setReceipt: (current: typeof receipt) => { receipt = current; } };
}

for (const locale of ["ko", "en"] as const) {
  test(`own account binding uses the server offer and command-bound passkey in ${locale} @ui-state`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    const fixture = await setup(page, locale);
    let writes = 0;
    await mockRoute(page, "post", command, request => {
      writes++;
      expect(request.postDataJSON()).toEqual({ employee_id: moveDetail.employee.id, confirmed_name: moveDetail.employee.name, step_up: {
        binding, assertion: { ceremony_id: id(7000), credential: { id: "test-passkey", type: "public-key" } },
      } });
      return { status: 201, json: { attestation_id: id(7000) } };
    });
    await openRecord(page);
    const button = page.getByRole("button", { name: t("uiOverrideSheet.stepUp", { action: t("people.account.ownLink") }), exact: true });
    await expect(button).toHaveCount(1);
    await expect(page.getByRole("region", { name: t("people.account.title"), exact: true }).getByRole("combobox")).toHaveCount(0);
    for (const theme of ["light", "dark"]) {
      await page.locator("html").evaluate((element, value) => { element.dataset.theme = value; }, theme);
      await fits(page, `own-account/${locale}/${theme}`);
      await expectAxe(page, `own-account/${locale}/${theme}`);
      await page.screenshot({ path: test.info().outputPath(`${theme}.png`), fullPage: true });
    }
    await page.getByRole("textbox", { name: t("people.account.confirmName", { name: moveDetail.employee.name }), exact: false }).fill(moveDetail.employee.name);
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
    if (withdrawing) fixture.setReceipt({ attestation_id: id(7000), employee_id: moveDetail.employee.id, can_withdraw: true });
    await mockRoute(page, "post", command, withdrawing ? { status: 201, json: { attestation_id: id(7000) } }
      : { status, json: { error: { code, message: "" } } });
    if (withdrawing) await mockRoute(page, "post", "/api/v1/users/me/employee-link/withdraw", { status, json: { error: { code, message: "" } } });
    await openRecord(page);
    if (!withdrawing) {
      await page.getByRole("textbox", { name: t("people.account.confirmName", { name: moveDetail.employee.name }), exact: false }).fill(moveDetail.employee.name);
      await page.getByRole("button", { name: t("uiOverrideSheet.stepUp", { action: t("people.account.ownLink") }), exact: true }).click();
    }
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
  await expect(page.getByRole("region", { name: t("people.account.title"), exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: t("uiOverrideSheet.stepUp", { action: t("people.account.ownLink") }), exact: true })).toHaveCount(0);
  await mockRoute(page, "post", prepare, { status: 200, json: binding });
  await openRecord(page, true);
  await expect(page.getByRole("button", { name: t("uiOverrideSheet.stepUp", { action: t("people.account.ownLink") }), exact: true })).toHaveCount(1);
  expect(fixture.unexpected).toEqual([]);
});

for (const locale of ["ko", "en"] as const) {
  test(`own-account receipt offers a passkey withdrawal in ${locale} @ui-state`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    const fixture = await setup(page, locale);
    let linked = false;
    await mockRoute(page, "get", "/api/v1/directory/people", () => ({ status: 200, json: {
      items: linked ? [{ ...user, display_name: moveDetail.employee.name, employee_id: moveDetail.employee.id, employee_link_status: "LINKED" as const }] : [],
      total: linked ? 1 : 0, limit: 20, offset: 0,
    } }));
    await mockRoute(page, "post", command, () => {
      linked = true;
      fixture.setReceipt({ attestation_id: id(7000), employee_id: moveDetail.employee.id, can_withdraw: true });
      return { status: 201, json: { attestation_id: id(7000) } };
    });
    let withdrawals = 0;
    await mockRoute(page, "post", "/api/v1/users/me/employee-link/withdraw", request => {
      expect(request.postDataJSON().attestation_id).toBe(id(7000));
      expect(request.postDataJSON().step_up.ceremony_id).toBe(id(7000));
      withdrawals++;
      linked = false;
      fixture.setReceipt(null);
      return { status: 200, json: {} };
    });
    await openRecord(page);
    await page.getByRole("textbox", { name: t("people.account.confirmName", { name: moveDetail.employee.name }), exact: false }).fill(moveDetail.employee.name);
    await page.getByRole("button", { name: t("uiOverrideSheet.stepUp", { action: t("people.account.ownLink") }), exact: true }).click();
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
    await expect(page.getByRole("button", { name: t("uiOverrideSheet.stepUp", { action: t("people.account.ownLink") }), exact: true })).toBeVisible();
  });
}

for (const locale of ["ko", "en"] as const) {
  test(`a nonmatching account deliberately confirms the record name in ${locale} @ui-state`, async ({ page }) => {
    const fixture = await setup(page, locale);
    let preparations = 0, writes = 0;
    await mockRoute(page, "post", prepare, request => {
      preparations++;
      if (!request.postDataJSON().confirmed_name) return { status: 403, json: failure("account_link.refuse.not_own_record") };
      expect(request.postDataJSON()).toEqual({ employee_id: moveDetail.employee.id, confirmed_name: moveDetail.employee.name });
      return { status: 200, json: binding };
    });
    await mockRoute(page, "post", command, request => {
      writes++;
      expect(request.postDataJSON().confirmed_name).toBe(moveDetail.employee.name);
      return { status: 201, json: { attestation_id: id(7000) } };
    });
    await openRecord(page);
    const button = page.getByRole("button", { name: t("uiOverrideSheet.stepUp", { action: t("people.account.ownLink") }), exact: true });
    await expect(button).toBeDisabled();
    const name = page.getByRole("textbox", { name: t("people.account.confirmName", { name: moveDetail.employee.name }), exact: false });
    await expect(name).toHaveValue("");
    await name.fill(`${moveDetail.employee.name}X`);
    await expect(button).toBeDisabled();
    expect(preparations).toBe(1); expect(writes).toBe(0);
    await name.fill(moveDetail.employee.name);
    await button.click();
    await expect.poll(() => writes).toBe(1);
    expect(preparations).toBeGreaterThanOrEqual(2);
    expect(fixture.unexpected).toEqual([]);
  });

  test(`a persisted own-account receipt recovers after reload in ${locale} @ui-state`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    const fixture = await setup(page, locale, false);
    let current = true;
    await mockRoute(page, "get", "/api/v1/directory/people", () => ({ status: 200, json: {
      items: current ? [{ ...user, display_name: moveDetail.employee.name, employee_id: moveDetail.employee.id, employee_link_status: "LINKED" as const }] : [],
      total: current ? 1 : 0, limit: 20, offset: 0,
    } }));
    await page.route(`**${command}`, route => route.request().method() === "GET" ? route.fulfill({ json: {
      attestation: current ? { attestation_id: id(7000), employee_id: moveDetail.employee.id, can_withdraw: true } : null,
    } }) : route.fallback());
    await mockRoute(page, "post", "/api/v1/users/me/employee-link/withdraw", request => {
      expect(request.postDataJSON().attestation_id).toBe(id(7000)); current = false;
      return { status: 200, json: {} };
    });
    await openRecord(page, false, true);
    const withdraw = page.getByRole("button", { name: t("uiOverrideSheet.stepUp", { action: t("people.account.withdrawOwn") }), exact: true });
    await expect(withdraw).toBeVisible();
    await openRecord(page, true, true);
    await expect(withdraw).toBeVisible();
    await expect(page.getByRole("region", { name: t("people.account.title"), exact: true }).getByRole("combobox")).toHaveCount(0);
    for (const theme of ["light", "dark"]) {
      await page.locator("html").evaluate((element, value) => { element.dataset.theme = value; }, theme);
      await fits(page, `recovered-receipt/${locale}/${theme}`);
      await expectAxe(page, `recovered-receipt/${locale}/${theme}`);
      await page.screenshot({ path: test.info().outputPath(`${theme}.png`), fullPage: true });
    }
    await withdraw.click();
    await expect(withdraw).toHaveCount(0);
    expect(fixture.unexpected).toEqual([]);
  });
}

test("a failed receipt read keeps binding controls closed until recovery @ui-state", async ({ page }) => {
  const fixture = await setup(page, "en");
  await page.route(`**${command}`, route => route.request().method() === "GET"
    ? route.fulfill({ status: 503, json: failure("service_unavailable") }) : route.fallback());
  await openRecord(page);
  const region = page.getByRole("region", { name: t("people.account.title"), exact: true });
  await expect(region.getByRole("button", { name: t("uiOverrideSheet.stepUp", { action: t("people.account.ownLink") }), exact: true })).toHaveCount(0);
  await expect(region.getByRole("button", { name: t("common.retry"), exact: true })).toBeVisible();
  await page.route(`**${command}`, route => route.request().method() === "GET"
    ? route.fulfill({ json: { attestation: null } }) : route.fallback());
  await region.getByRole("button", { name: t("common.retry"), exact: true }).click();
  await expect(region.getByRole("button", { name: t("uiOverrideSheet.stepUp", { action: t("people.account.ownLink") }), exact: true })).toBeVisible();
  expect(fixture.unexpected).toEqual([]);
});

test("receipt withdrawal follows the server offer and stays on its employee record @ui-state", async ({ page }) => {
  const fixture = await setup(page, "en", false);
  const receipt = { attestation_id: id(7000), employee_id: moveDetail.employee.id, can_withdraw: false };
  fixture.setReceipt(receipt);
  await openRecord(page);
  const badge = page.getByText(t("people.account.selfAttested"), { exact: true });
  const withdraw = page.getByRole("button", { name: t("uiOverrideSheet.stepUp", { action: t("people.account.withdrawOwn") }), exact: true });
  await expect(badge).toBeVisible();
  await expect(withdraw).toHaveCount(0);
  fixture.setReceipt({ ...receipt, can_withdraw: true });
  await openRecord(page, true);
  await expect(withdraw).toBeVisible();
  fixture.setReceipt({ ...receipt, employee_id: id(7100), can_withdraw: true });
  await openRecord(page, true);
  await expect(badge).toHaveCount(0);
  await expect(withdraw).toHaveCount(0);
  expect(fixture.unexpected).toEqual([]);
});


test("account-link controls load on the access tab and keep the offer in place @ui-state", async ({ page }) => {
  const fixture = await setup(page, "ko");
  await page.setViewportSize({ width: 390, height: 900 });
  let loads = 0, release!: () => void;
  const held = new Promise<void>(done => { release = done; });
  await page.route("**/assets/person-act-*.js", async route => {
    loads++;
    await held;
    await route.continue();
  });
  await page.goto(`/people/${moveDetail.employee.id}`);
  await expect(page.getByRole("heading", { name: moveDetail.employee.name, exact: true })).toBeVisible();
  expect(loads).toBe(0);
  await page.goto(`/people/${moveDetail.employee.id}?tab=access`);
  await expect.poll(() => loads).toBe(1);
  const heading = page.getByRole("heading", { name: t("people.account.title"), exact: true });
  await expect(heading).toBeVisible();
  const before = await heading.boundingBox();
  release();
  const button = page.getByRole("button", { name: t("uiOverrideSheet.stepUp", { action: t("people.account.ownLink") }), exact: true });
  await expect(button).toBeVisible();
  expect(await heading.boundingBox()).toEqual(before);
  const offered = await button.boundingBox();
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  expect(await button.boundingBox()).toEqual(offered);
  await expect(page.getByRole("region", { name: t("people.account.title"), exact: true }).getByRole("combobox")).toHaveCount(0);
  expect(fixture.unexpected).toEqual([]);
});
