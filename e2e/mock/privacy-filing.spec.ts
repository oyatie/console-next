// SPDX-License-Identifier: LicenseRef-Proprietary
import { createHash } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { fits, expectAxe } from "../a11y";
import { mockScreen } from "./screen";
import { chooseRadio } from "../flows";
import { screens } from "../states/registry";
import { user } from "./fixtures";

const options = {
  subject_user_id: user.id, as_of: "2026-11-05",
  controllers: [{ code: "TENANT" }],
  kinds: [
    { code: "ACCESS", due_on: "2026-11-22", without_delay: false },
    { code: "WITHDRAWAL", due_on: null, without_delay: true },
  ],
  detail_max_length: 2000, reply_email_masked: "j***@example.test",
};
const receipt = { id: "request-1", receipt_no: "RR-2026-002", detail: "로그인 기록", status: "RECEIVED",
  receipt: { controller: "TENANT", received_on: "2026-11-05", identity_at: "2026-11-05T01:00:00Z" },
  kinds: { ACCESS: { due: { on: "2026-11-22", without_delay: false, rule: null }, decisions: [] } } };

async function filing(page: Page, config = options) {
  const fixture = await mockScreen(page, screens[0], "populated");
  const writes: { body: Record<string, unknown>; key: string | undefined }[] = [];
  await page.route("**/api/v1/privacy/rights-requests/options", route => route.fulfill({ json: config }));
  await page.route("**/api/v1/privacy/rights-requests/mine*", route => route.fulfill({ json: { items: writes.length ? [receipt] : [], next_cursor: null, as_of: "2026-11-05" } }));
  await page.route("**/api/v1/privacy/rights-requests", route => {
    writes.push({ body: route.request().postDataJSON(), key: route.request().headers()["idempotency-key"] });
    return route.fulfill({ json: receipt });
  });
  await page.route("**/api/v1/auth/passkey/step-up/start", route => route.fulfill({ json: { ceremony_id: "privacy-ceremony", challenge: { publicKey: { challenge: "Y2hhbGxlbmdl" } } } }));
  await page.addInitScript(() => {
    Object.defineProperty(navigator.credentials, "get", { configurable: true, value: async () => {
      if (sessionStorage.getItem("cancel-passkey")) throw new DOMException("Cancelled", "NotAllowedError");
      return { toJSON: () => ({ id: "credential" }) };
    } });
  });
  await page.goto("/account/privacy");
  return { ...fixture, writes };
}
async function fill(page: Page) {
  await expect(page.getByRole("radio", { name: /내 인사 정보/ })).toBeVisible();
  await chooseRadio(page.getByRole("main"), /내 인사 정보/);
  await page.getByRole("checkbox", { name: /열람/ }).press("Space");
  await page.getByRole("textbox", { name: /내용/ }).fill("로그인 기록");
}

for (const width of [390, 1440]) test(`filing uses registered choices and deadlines at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 });
  const fixture = await filing(page);
  await expect(page.getByRole("radio", { name: /내 계정 정보/ })).toHaveCount(0);
  await expect(page.getByRole("checkbox", { name: /자동화|전송/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "요구 접수", exact: true })).toBeDisabled();
  await fill(page);
  await expect(page.getByText(/2026\. 11\. 22\./)).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "열람 · 기록된 정보를 확인합니다", exact: true })).toBeVisible();
  await expect(page.getByText(options.reply_email_masked, { exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: /내용/ })).toHaveAttribute("maxlength", "2000");
  for (const theme of ["light", "dark"]) {
    await page.locator("html").evaluate((el, value) => { el.dataset.theme = value; }, theme);
    await fits(page, `filing/${width}/${theme}`);
    await expectAxe(page, `filing/${width}/${theme}`);
    await page.screenshot({ path: info.outputPath(`filing-${width}-${theme}.png`), fullPage: true });
  }
  expect(fixture.unexpected).toEqual([]);
});

test("passkey cancellation and reload keep the draft; submit binds the exact payload then opens the receipt", async ({ page }) => {
  const fixture = await filing(page);
  await page.route("**/api/v1/privacy/rights-requests/mine*", route => route.fulfill({ json: { items: [], next_cursor: null, as_of: "2026-11-05" } }));
  await fill(page);
  await page.evaluate(() => sessionStorage.setItem("cancel-passkey", "1"));
  await page.getByRole("button", { name: "요구 접수", exact: true }).click();
  await expect(page.getByRole("button", { name: "요구 접수", exact: true })).toBeEnabled();
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(fixture.writes).toHaveLength(0);
  await page.reload();
  await expect(page.getByRole("textbox", { name: /내용/ })).toHaveValue("로그인 기록");
  await expect(page.getByRole("checkbox", { name: /열람/ })).toBeChecked();
  await expect(page.getByRole("radio", { name: /내 인사 정보/ })).toBeChecked();
  await page.evaluate(() => sessionStorage.removeItem("cancel-passkey"));
  await page.getByRole("button", { name: "요구 접수", exact: true }).click();
  const panel = page.locator("[data-side-panel]");
  await expect(panel.getByRole("heading", { name: receipt.receipt_no, exact: true })).toBeVisible();
  await expect(panel.getByText("D-17", { exact: true })).toBeVisible();
  expect(fixture.writes).toHaveLength(1);
  const { body, key } = fixture.writes[0]!;
  expect(key).toBeTruthy();
  expect(body).toMatchObject({ controller: "TENANT", kinds: ["ACCESS"], detail: "로그인 기록",
    step_up: { binding: { action_kind: "PRIVACY_REQUEST", object_id: user.id, reason_key: "passkey_step_up_privacy_request",
      payload_hash: createHash("sha256").update(JSON.stringify({ controller: "TENANT", kinds: ["ACCESS"], detail: "로그인 기록" })).digest("hex") },
      assertion: { ceremony_id: "privacy-ceremony", credential: { id: "credential" } } } });
  await page.reload();
  await expect(page.getByRole("textbox", { name: /내용/ })).toHaveValue("");
  expect(fixture.unexpected).toEqual([]);
});

test("only registered kinds remain submittable after options change", async ({ page }) => {
  await filing(page);
  await fill(page);
  await page.route("**/api/v1/privacy/rights-requests/options", route => route.fulfill({ json: { ...options, kinds: [] } }));
  await page.reload();
  await expect(page.getByRole("button", { name: "요구 접수", exact: true })).toBeDisabled();
  await expect(page.getByRole("checkbox")).toHaveCount(0);
});

for (const code of ["passkey_step_up_failed", "no_employee_record", "request_kind_required", "request_kind_unavailable", "detail_too_long"]) test(`filing refusal ${code} keeps input`, async ({ page }) => {
  const fixture = await filing(page);
  await page.route("**/api/v1/privacy/rights-requests", route => route.fulfill({ status: code.startsWith("passkey") ? 403 : 422, json: { error: { code, message: code } } }));
  await fill(page);
  await page.getByRole("button", { name: "요구 접수", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("textbox", { name: /내용/ })).toHaveValue("로그인 기록");
  expect(fixture.unexpected).toEqual([]);
});

test("code-only options use the English catalog after a language change", async ({ page }) => {
  await filing(page);
  await page.getByRole("combobox", { name: "언어", exact: true }).selectOption("en");
  await expect(page.getByRole("radio", { name: /My HR information/ })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Access · View your recorded information", exact: true })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Consent withdrawal · Withdraw consent to information processing", exact: true })).toBeVisible();
});

for (const width of [390, 1440]) test(`unlinked account has no filing controls at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  await filing(page, { ...options, controllers: [] });
  await expect(page.getByText("현재 이 계정에서 접수할 수 있는 권리 요구가 없습니다", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "요구 접수", exact: true })).toHaveCount(0);
  await expect(page.getByRole("radio")).toHaveCount(0);
  for (const theme of ["light", "dark"]) {
    await page.locator("html").evaluate((el, value) => { el.dataset.theme = value; }, theme);
    await fits(page, `unlinked filing ${theme}`);
    await expectAxe(page, `unlinked filing ${theme}`);
  }
});
