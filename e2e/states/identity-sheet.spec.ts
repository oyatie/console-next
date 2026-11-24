// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { expectAxe, fits } from "../a11y";
import { failure } from "../mock/fixtures";
import { mockScreen } from "../mock/screen";
import { clearShifts, expectStable, recordShifts } from "../stability";
import { lifecycleSheetScreens } from "./lifecycle-sheets";

test.beforeAll(() => loadCatalog("ko"));
for (const status of [500, 403]) for (const width of [1440, 390]) {
  test(`identity evidence ${status} keeps the resolution form usable at ${width}px @ui-state`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const screen = lifecycleSheetScreens[0];
    const fixture = await mockScreen(page, screen, "populated");
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    await page.route(url => url.pathname === "/api/v1/person-binding-reviews", async route => {
      await held;
      await route.fulfill({ status, json: failure(status === 403 ? "forbidden" : "internal") });
    });
    const requested = page.waitForRequest(request => new URL(request.url()).pathname === "/api/v1/person-binding-reviews");
    await page.goto(screen.path.replace("act=TRANSFER", "act=identity"));
    const sheet = page.getByRole("dialog", { name: t("identity.title", { name: "배치직원" }), exact: true });
    // The card head waits for the evidence (its review chip lands there), so the sheet opens with the evidence's answer.
    await requested;
    release();
    await expect(sheet.getByText(t(status === 403 ? "common.denied.title.plain" : "common.loadFailed.title"), { exact: true })).toBeVisible({ timeout: 15_000 });
    const verdict = sheet.getByRole("radiogroup", { name: t("identity.verdict") });
    await expect(verdict.getByRole("radio")).toHaveCount(2);
    const different = verdict.getByRole("radio", { name: t("identity.different") });
    await different.focus();
    await different.press("Space");
    await expect(different).toBeChecked();
    const reason = sheet.getByRole("textbox", { name: t("profile.reason") });
    await reason.fill("사번이 다른 별도 직원");
    await expect(reason).toHaveValue("사번이 다른 별도 직원");
    await expect(sheet.locator('[data-read-layout="form"]')).toHaveCount(0);
    await fits(page, `identity-evidence/${status}/${width}`);
    await expectAxe(page, `identity-evidence/${status}/${width}`);
    expect(fixture.unexpected).toEqual([]);
  });
}

test("open binding evidence lands its review chip in the name row without moving the card under it @ui-state", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.addInitScript(recordShifts);
  const screen = lifecycleSheetScreens[0];
  const fixture = await mockScreen(page, screen, "populated");
  const held = Promise.withResolvers<void>();
  const requested = page.waitForRequest(request => new URL(request.url()).pathname === "/api/v1/person-binding-reviews");
  await page.route(url => url.pathname === "/api/v1/person-binding-reviews", async route => {
    await held.promise;
    const subject = new URL(route.request().url()).searchParams.get("subject_id");
    await route.fulfill({ json: { items: [{ subject_kind: "EMPLOYEE", subject_id: subject, reason: "NUMBER_BIRTH_AMBIGUOUS", created_at: "2026-10-01T00:00:00Z", evidence: { candidates: [] } }], total: 1, limit: 50, offset: 0 } });
  });
  try {
    await page.goto(screen.path.replace("?act=TRANSFER", ""));
    await requested;
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(clearShifts);
    held.resolve();
    await expect(page.getByRole("button", { name: t("person.identity"), exact: true })).toBeVisible();
    await expect(page.getByRole("navigation", { name: t("empCard.tabs"), exact: true })).toBeVisible();
    await expectStable(page, "binding review chip");
    expect(fixture.unexpected).toEqual([]);
  } finally {
    held.resolve();
  }
});
