// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { expectAxe, fits } from "../a11y";
import { attendanceReads } from "../mock/attendance";
import { refusalText } from "../../apps/web/src/features/attendance/present";
import { mockScreen } from "../mock/screen";
import { attendanceBoardScreens, attendanceScreens } from "./attendance";
import { screens } from "./registry";

test.beforeAll(() => loadCatalog("ko"));
test.setTimeout(120_000);

for (const screen of [...attendanceScreens, ...attendanceBoardScreens]) for (const theme of ["light", "dark"]) {
  test(`${screen.key} refusal diagnostics stay behind a keyboard disclosure in ${theme} @ui-state`, async ({ page }) => {
    await page.addInitScript(value => localStorage.setItem("console.theme", value), theme);
    const fixture = "tab" in screen
      ? { ...await mockScreen(page, screens[0], "populated"), ...await attendanceReads(page, screen, "refused") }
      : await mockScreen(page, screen, "refused");
    await page.goto(screen.path);
    const heading = page.getByRole("heading", { name: t("common.denied.title.plain"), exact: true });
    await expect(heading).toHaveCount(1, { timeout: 15_000 });
    const card = page.getByRole("region", { name: t("common.denied.title.plain"), exact: true });
    const disclosure = card.locator("details"), summary = disclosure.locator("summary");
    const diagnostic = card.locator("code").filter({ hasText: /^forbidden$/ });
    await expect(diagnostic).toHaveAttribute("translate", "no");
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(card.getByRole("button", { name: t("common.denied.request"), exact: true })).toBeVisible();
      await expect(card.getByRole("link", { name: t("common.denied.back"), exact: true })).toBeVisible();
      await expect(card.locator("[data-support-reference]")).toBeVisible();
      await page.screenshot({ path: test.info().outputPath(`refused-${width}.png`), fullPage: true });
      await expect(diagnostic).toBeHidden();
      await summary.focus();
      await page.keyboard.press("Enter");
      await expect(disclosure).toHaveAttribute("open", "");
      await expect(diagnostic).toBeVisible();
      const reason = screen.key === "attendance-month" || screen.key === "attendance-day" ? refusalText("forbidden")! : t("common.denied.reason");
      await expect(disclosure.getByText(reason, { exact: true })).toBeVisible();
      await page.keyboard.press("Space");
      await expect(disclosure).not.toHaveAttribute("open");
      await expect(summary).toBeFocused();
      await expect(diagnostic).toBeHidden();
      await fits(page, `${screen.key}/refused/${width}/${theme}`);
      await expectAxe(page, `${screen.key}/refused/${width}/${theme}`);
    }
    expect(fixture.unexpected).toEqual([]);
    fixture.release();
  });
}
