// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { rrn } from "../helpers/import-layouts";

for (const width of [1440, 390]) {
  test(`pending RRN sheet stays available in the gallery at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/_gallery");
    if (width === 390) {
      await expect(page.getByRole("dialog")).toBeVisible();
      await page.keyboard.press("Escape");
    }
    const section = page.getByRole("heading", { name: "주민등록번호 기록", exact: true }).locator("..");
    await section.getByRole("button", { name: "기록", exact: true }).click();
    const sheet = page.getByRole("dialog", { name: "주민등록번호 기록" });
    const input = sheet.getByRole("textbox", { name: /^주민등록번호/ });
    await expect(input).toHaveAttribute("autocomplete", "off");
    await input.fill(rrn("1990-01-01", 1, 8));
    for (const theme of ["light", "dark"]) {
      await page.locator("html").evaluate((el, theme) => { el.dataset.theme = theme; }, theme);
      const { violations } = await new AxeBuilder({ page }).include('[role="dialog"]').withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
      expect(violations).toEqual([]);
    }
    await sheet.getByRole("button", { name: "닫기", exact: true }).last().click();
    await section.getByRole("button", { name: "기록", exact: true }).click();
    await expect(input).toHaveValue("");
    await expect(sheet.getByRole("button", { name: "기록", exact: true })).toBeDisabled();
  });
}
