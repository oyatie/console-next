// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test("module tabs round-trip URL state and keep unrelated filters through browser history", async ({ page }) => {
  await page.goto("/_gallery?tab=list&scope=workplace#record");
  const demo = page.locator('[data-tabs-demo="url"]');
  const selected = demo.getByRole("tab", { selected: true });
  await expect(selected).toHaveAccessibleName("목록 61");
  await demo.getByRole("tab", { name: "아웃라인", exact: true }).click();
  await expect(page).toHaveURL(/tab=outline.*scope=workplace#record$/);
  await page.reload();
  await expect(selected).toHaveAccessibleName("아웃라인");
  await page.goBack();
  await expect(selected).toHaveAccessibleName("목록 61");
  await page.goForward();
  await expect(selected).toHaveAccessibleName("아웃라인");
  await demo.getByRole("tab", { name: "조직도", exact: true }).click();
  await expect(page).toHaveURL(/scope=workplace#record$/);
  expect(new URL(page.url()).searchParams.has("tab")).toBe(false);
});

for (const width of [1440, 390]) {
  for (const theme of ["light", "dark"]) {
    test(`tabs cover read states, long labels and large counts at ${width}px in ${theme}`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto("/_gallery?tab=unknown");
      if (width === 390) {
        await expect(page.getByRole("dialog")).toBeVisible();
        await page.keyboard.press("Escape");
      }
      await page.locator("html").evaluate((el, value) => { el.dataset.theme = value; }, theme);
      const section = page.locator("[data-tabs-gallery]");
      const url = section.locator('[data-tabs-demo="url"]');
      await expect(url.getByRole("tab", { selected: true })).toHaveAccessibleName("조직도");
      for (const state of ["loading", "empty", "failed", "refused"]) {
        const demo = section.locator(`[data-tabs-demo="${state}"]`);
        await expect(demo.getByRole("tablist")).toBeVisible();
        await expect(demo.getByRole("tabpanel")).toBeVisible();
        await expect(demo.getByRole("tab", { selected: true })).toHaveAccessibleName(state === "empty" ? "목록 0" : "목록");
      }
      await expect(section.locator('[data-tabs-demo="loading"] [aria-busy="true"]')).toBeVisible();
      await expect(section.locator('[data-tabs-demo="empty"]')).toContainText("표시할 항목이 없습니다");
      for (const state of ["failed", "refused"]) {
        await expect(section.locator(`[data-tabs-demo="${state}"] [data-support-reference]`)).toHaveAttribute("data-support-reference", `gallery-tabs-${state}`);
      }
      const long = section.locator('[data-tabs-demo="long"]');
      await expect(long.getByRole("tab")).toHaveCount(8);
      await expect(long.getByRole("tab").first()).toContainText("2,000");
      await long.getByRole("tab").first().focus();
      await page.keyboard.press("End");
      await expect(long.getByRole("tab").last()).toBeFocused();
      await expect(long.getByRole("tab").last()).toHaveAttribute("aria-selected", "true");
      expect(await section.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      expect(await section.getByRole("tablist").evaluateAll(lists => lists.every(el => el.scrollWidth <= el.clientWidth))).toBe(true);
      const { violations } = await new AxeBuilder({ page }).include("[data-tabs-gallery]").withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
      expect(violations).toEqual([]);
      await section.screenshot({ path: info.outputPath(`tabs-${width}-${theme}.png`), animations: "disabled" });
    });
  }
}
