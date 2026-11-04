// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import type { components } from "@console/api/schema";
import { loadCatalog, t } from "@console/i18n";
import { expectAxe, fits } from "../a11y";
import { accountReads } from "./account";
import { mockScreen } from "./screen";
import { screens } from "../states/registry";

const receipt = {
  id: "request-1", receipt_no: "RR-2026-001", controller_label: "모의테스트상사",
  kinds: [{ code: "ACCESS", label: "열람" }], detail: "내 인사 기록 열람",
  received_at: "2026-11-01T00:00:00Z", status: { code: "RECEIVED", label: "접수", tone: "info" },
  clock: { due_at: "2026-11-11T00:00:00Z", days_left: 6, severity: "due" },
  outcomes: [], notified_at: null, objection_method: null, retention_notice: "【확인 필요】 보존 기간 미정",
};
function wireReceipt(id = receipt.id, receipt_no = receipt.receipt_no): components["schemas"]["PrivacyRightsReceipt"] {
  return { id, receipt_no, detail: receipt.detail, status: "RECEIVED",
    receipt: { controller: "TENANT", received_on: "2026-11-01", identity_at: receipt.received_at },
    kinds: { ACCESS: { due: { on: "2026-11-11", without_delay: false, rule: null }, decisions: [] } } };
}
test.beforeAll(() => loadCatalog("ko"));
for (const width of [1440, 390]) for (const state of ["populated", "empty", "loading", "failed", "refused", "decided", "without-delay", "clock-unknown"] as const) {
  test(`privacy requests: ${state} at ${width}px @ui-state`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const fixture = await mockScreen(page, screens[0], "populated");
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    await page.route("**/api/v1/privacy/rights-requests/mine*", async route => {
      if (state === "loading") await held;
      if (page.isClosed()) return;
      if (state === "failed" || state === "refused") return route.fulfill({ status: state === "failed" ? 503 : 403, json: { error: { code: state === "failed" ? "service_unavailable" : "forbidden", message: "요구 내역을 불러오지 못했습니다." } } });
      const row = wireReceipt();
      if (state === "without-delay") row.kinds = { WITHDRAWAL: { due: { on: null, without_delay: true, rule: null }, decisions: [] } };
      if (state === "clock-unknown") row.kinds.ACCESS!.due = null;
      if (state === "decided") { row.status = "DECIDED"; row.kinds.ACCESS!.decisions.push({ on: "2026-11-05", decision: { outcome: "GRANTED", reason: null, note: null } }); }
      return route.fulfill({ json: { items: state === "empty" ? [] : [row], next_cursor: null, as_of: "2026-11-05" } });
    });
    await page.goto("/account/privacy");
    await expect(page.getByRole("heading", { name: t("account.privacy.title"), exact: true })).toBeVisible();
    if (state === "empty") await expect(page.getByText(t("account.privacy.empty.title"), { exact: true })).toBeVisible();
    else if (state === "loading") await expect(page.getByRole("status", { name: t("common.loading"), exact: true })).toBeVisible();
    else if (state === "failed" || state === "refused") {
      await expect(page.getByText(receipt.receipt_no)).toHaveCount(0);
      if (state === "refused") {
        await expect(page.getByRole("heading", { name: t("account.privacy.refused.title"), exact: true })).toBeVisible();
        await expect(page.getByText(t("account.privacy.refused"), { exact: true })).toBeVisible();
        await expect(page.getByText(t("account.privacy.empty.title"), { exact: true })).toHaveCount(0);
        await expect(page.getByRole("button", { name: t("common.denied.request"), exact: true })).toHaveCount(0);
      }
      if (state === "failed") await expect(page.getByRole("button", { name: t("common.retry"), exact: true })).toBeVisible({ timeout: 15_000 });
    } else {
      if (!["decided", "without-delay", "clock-unknown"].includes(state)) await expect(page.getByText("D-6", { exact: true })).toBeVisible();
      else await expect(page.getByText("D-6", { exact: true })).toHaveCount(0);
      await page.getByText(receipt.receipt_no, { exact: true }).click();
      const panel = page.locator("[data-side-panel]");
      await expect(panel.getByText(t("account.privacy.controller.TENANT"), { exact: true })).toBeVisible();
      await expect(panel.getByText(receipt.detail, { exact: true })).toBeVisible();
      await expect(panel.getByText(t("account.privacy.status"), { exact: true })).toBeVisible();
      await expect(panel.getByText(state === "decided" ? "결정 완료" : "접수", { exact: true })).toBeVisible();
      await expect(panel.getByText(receipt.retention_notice, { exact: true })).toBeVisible();
      if (!["decided", "without-delay", "clock-unknown"].includes(state)) await expect(panel.getByText("D-6", { exact: true })).toBeVisible();
      else if (state === "decided") await expect(panel.getByText("수용", { exact: true })).toBeVisible();
      else await expect(panel.getByText(t(state === "without-delay" ? "account.privacy.withoutDelay" : "account.privacy.noClock"), { exact: true })).toBeVisible();
    }
    await fits(page, `privacy/${state}/${width}`);
    await expectAxe(page, `privacy/${state}/${width}`);
    if (state === "populated") for (const theme of ["light", "dark"]) {
      await page.locator("html").evaluate((element, value) => { element.dataset.theme = value; }, theme);
      await fits(page, `privacy/${state}/${width}/${theme}`);
      await page.screenshot({ path: testInfo.outputPath(`${state}-${width}-${theme}.png`), fullPage: true });
    }
    expect(fixture.unexpected).toEqual([]);
    release();
  });
}

for (const width of [1440, 390]) test(`account keeps unfinished rights filing hidden at ${width}px`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 900 });
  const fixture = await mockScreen(page, screens[0], "populated");
  await accountReads(page, "save-unchanged");
  await page.goto("/account");
  await expect(page.getByRole("heading", { name: t("account.title"), exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: t("account.privacy.title"), exact: true })).toHaveCount(0);
  for (const theme of ["light", "dark"]) {
    await page.locator("html").evaluate((element, value) => { element.dataset.theme = value; }, theme);
    await fits(page, `account/${width}/${theme}`);
    await page.screenshot({ path: testInfo.outputPath(`account-${width}-${theme}.png`), fullPage: true });
  }
  expect(fixture.unexpected).toEqual([]);
});

test("rights history loads the server cursor without losing earlier receipts", async ({ page }) => {
  const fixture = await mockScreen(page, screens[0], "populated");
  const cursors: (string | null)[] = [];
  await page.route("**/api/v1/privacy/rights-requests/mine*", route => {
    const cursor = new URL(route.request().url()).searchParams.get("cursor");
    cursors.push(cursor);
    return route.fulfill({ json: { items: [wireReceipt(cursor ? "request-2" : receipt.id, cursor ? "RR-2026-002" : receipt.receipt_no)], next_cursor: cursor ? null : "next-receipt", as_of: "2026-11-05" } });
  });
  await page.goto("/account/privacy");
  await page.getByRole("button", { name: t("account.privacy.more"), exact: true }).click();
  await expect(page.getByText("RR-2026-002", { exact: true })).toBeVisible();
  await expect(page.getByText(receipt.receipt_no, { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: t("account.privacy.more"), exact: true })).toHaveCount(0);
  expect(cursors).toEqual([null, "next-receipt"]);
  expect(fixture.unexpected).toEqual([]);
});
