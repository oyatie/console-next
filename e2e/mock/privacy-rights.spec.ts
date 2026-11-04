// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
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
test.beforeAll(() => loadCatalog("ko"));
for (const width of [1440, 390]) for (const state of ["populated", "empty", "loading", "failed", "refused", "notified", "withdrawn", "postponed"] as const) {
  test(`privacy requests: ${state} at ${width}px @ui-state`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const fixture = await mockScreen(page, screens[0], "populated");
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    await page.route("**/api/v1/privacy/rights-requests/mine*", async route => {
      if (state === "loading") await held;
      if (page.isClosed()) return;
      if (state === "failed" || state === "refused") return route.fulfill({ status: state === "failed" ? 503 : 403, json: { error: { code: state === "failed" ? "service_unavailable" : "forbidden", message: "요구 내역을 불러오지 못했습니다." } } });
      return route.fulfill({ json: { items: state === "empty" ? [] : [{ ...receipt,
        status: state === "notified" ? { code: "NOTIFIED", label: "결과 통지", tone: "neutral" } : state === "withdrawn" ? { code: "WITHDRAWN", label: "철회", tone: "neutral" } : state === "postponed" ? { code: "POSTPONED", label: "연장 통지", tone: "warn" } : receipt.status,
        clock: state === "notified" || state === "withdrawn" ? null : receipt.clock,
        outcomes: state === "notified" ? [{ kind_label: "열람", outcome_label: "일부 수용", reason_label: "다른 사람의 권익 침해", note: "제삼자 정보 제외" }] : [],
        objection_method: state === "notified" ? "【확인 필요】 접수 부서에 이의 제기" : null,
        notified_at: state === "notified" ? "2026-11-04T00:00:00Z" : null,
      }], next_cursor: null } });
    });
    await page.goto("/account/privacy");
    await expect(page.getByRole("heading", { name: t("account.privacy.title"), exact: true })).toBeVisible();
    if (state === "empty") await expect(page.getByText(t("account.privacy.empty.title"), { exact: true })).toBeVisible();
    else if (state === "loading") await expect(page.getByRole("status", { name: t("common.loading"), exact: true })).toBeVisible();
    else if (state === "failed" || state === "refused") {
      await expect(page.getByText(receipt.receipt_no)).toHaveCount(0);
      if (state === "failed") await expect(page.getByRole("button", { name: t("common.retry"), exact: true })).toBeVisible({ timeout: 15_000 });
    } else {
      await page.getByText(receipt.receipt_no, { exact: true }).click();
      const panel = page.locator("[data-side-panel]");
      await expect(panel.getByText(receipt.controller_label, { exact: true })).toBeVisible();
      await expect(panel.getByText(receipt.detail, { exact: true })).toBeVisible();
      await expect(panel.getByText(receipt.retention_notice, { exact: true })).toBeVisible();
      if (state === "notified") {
        await expect(panel.getByText("다른 사람의 권익 침해", { exact: true })).toBeVisible();
        await expect(panel.getByText("【확인 필요】 접수 부서에 이의 제기", { exact: true })).toBeVisible();
      } else if (state !== "withdrawn") await expect(panel.getByText("D-6", { exact: true })).toBeVisible();
      if (state === "withdrawn" || state === "notified") await expect(panel.getByText("D-6")).toHaveCount(0);
    }
    await fits(page, `privacy/${state}/${width}`);
    await expectAxe(page, `privacy/${state}/${width}`);
    if (state === "populated" || state === "notified") for (const theme of ["light", "dark"]) {
      await page.locator("html").evaluate((element, value) => { element.dataset.theme = value; }, theme);
      await fits(page, `privacy/${state}/${width}/${theme}`);
      await page.screenshot({ path: testInfo.outputPath(`${state}-${width}-${theme}.png`), fullPage: true });
    }
    expect(fixture.unexpected).toEqual([]);
    release();
  });
}

for (const width of [1440, 390]) test(`account opens rights requests without an administrative grant at ${width}px`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 900 });
  const fixture = await mockScreen(page, screens[0], "populated");
  await accountReads(page, "save-unchanged");
  await page.route("**/api/v1/privacy/rights-requests/mine*", route => route.fulfill({ json: { items: [], next_cursor: null } }));
  await page.goto("/account");
  const entry = page.getByRole("link", { name: t("account.privacy.title"), exact: true });
  await expect(entry).toBeVisible();
  await expectAxe(page, `account entry/${width}`);
  for (const theme of ["light", "dark"]) {
    await page.locator("html").evaluate((element, value) => { element.dataset.theme = value; }, theme);
    await fits(page, `account entry/${width}/${theme}`);
    await page.screenshot({ path: testInfo.outputPath(`account-${width}-${theme}.png`), fullPage: true });
  }
  await entry.click();
  await expect(page).toHaveURL(/\/account\/privacy$/);
  await expect(page.getByText(t("account.privacy.empty.title"), { exact: true })).toBeVisible();
  expect(fixture.unexpected).toEqual([]);
});

test("rights history loads the server cursor without losing earlier receipts", async ({ page }) => {
  const fixture = await mockScreen(page, screens[0], "populated");
  const cursors: (string | null)[] = [];
  await page.route("**/api/v1/privacy/rights-requests/mine*", route => {
    const cursor = new URL(route.request().url()).searchParams.get("cursor");
    cursors.push(cursor);
    return route.fulfill({ json: { items: [{ ...receipt, id: cursor ? "request-2" : receipt.id, receipt_no: cursor ? "RR-2026-002" : receipt.receipt_no }], next_cursor: cursor ? null : "next-receipt" } });
  });
  await page.goto("/account/privacy");
  await page.getByRole("button", { name: t("account.privacy.more"), exact: true }).click();
  await expect(page.getByText("RR-2026-002", { exact: true })).toBeVisible();
  await expect(page.getByText(receipt.receipt_no, { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: t("account.privacy.more"), exact: true })).toHaveCount(0);
  expect(cursors).toEqual([null, "next-receipt"]);
  expect(fixture.unexpected).toEqual([]);
});
