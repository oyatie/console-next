// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { expectAxe, fits } from "../a11y";
import { failure } from "../mock/fixtures";
import { mockScreen } from "../mock/screen";
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
    await page.goto(screen.path.replace("act=TRANSFER", "act=identity"));
    const sheet = page.getByRole("dialog", { name: t("identity.title", { name: "배치직원" }), exact: true });
    await expect(sheet.locator('[data-read-layout="form"]')).toBeVisible();
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
