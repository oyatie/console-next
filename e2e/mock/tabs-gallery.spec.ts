// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test("module links replace history and preserve copyable URLs, filters and Back", async ({ page }) => {
  await page.goto("/_gallery?scope=previous");
  await page.goto("/_gallery?tab=list&scope=workplace#record");
  const demo = page.locator('[data-tabs-demo="url"]');
  const selected = demo.locator('[aria-current="page"]');
  await expect(selected).toHaveAccessibleName("목록 61");
  const outline = demo.getByRole("link", { name: "아웃라인", exact: true });
  const length = await page.evaluate(() => history.length);
  await expect(outline).toHaveAttribute("href", "/_gallery?tab=outline&scope=workplace#record");
  for (const init of [{ button: 1 }, { ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }]) {
    const prevented = await outline.evaluate((el, init) => {
      let prevented = false;
      // Observe after React's handler, then suppress the browser action in this synthetic probe.
      window.addEventListener("click", event => {
        prevented = event.defaultPrevented;
        event.preventDefault();
      }, { once: true });
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...init }));
      return prevented;
    }, init);
    expect(prevented, JSON.stringify(init)).toBe(false);
    await expect(selected).toHaveAccessibleName("목록 61");
  }
  await expect(selected).toHaveAccessibleName("목록 61");
  await outline.click();
  await expect(page).toHaveURL(/tab=outline.*scope=workplace#record$/);
  expect(await page.evaluate(() => history.length)).toBe(length);
  await page.reload();
  await expect(selected).toHaveAccessibleName("아웃라인");
  await demo.getByRole("link", { name: "조직도", exact: true }).click();
  await expect(page).toHaveURL(/scope=workplace#record$/);
  expect(new URL(page.url()).searchParams.has("tab")).toBe(false);
  await page.goBack();
  await expect(page).toHaveURL(/scope=previous$/);
  await page.goForward();
  await expect(selected).toHaveAccessibleName("조직도");
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
      await expect(url.getByRole("navigation")).toBeVisible();
      await expect(url.locator('[aria-current="page"]')).toHaveAccessibleName("조직도");
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
      const more = long.getByRole("button", { name: "더 보기", exact: true });
      await expect(more).toBeVisible();
      await expect(long.locator('[aria-current="page"]')).toContainText("2,000");
      const row = long.getByRole("navigation");
      expect(await row.evaluate(el => el.getBoundingClientRect().height)).toBeLessThanOrEqual(56);
      await more.click();
      const popup = page.getByRole("dialog", { name: "더 보기", exact: true });
      const last = popup.getByRole("link").last();
      const lastName = await last.textContent();
      await last.focus();
      await last.press("Enter");
      await expect(popup).toBeHidden();
      await expect(long.locator('[aria-current="page"]')).toHaveText(lastName!);
      await page.reload();
      await expect(long.locator('[aria-current="page"]')).toHaveText(lastName!);
      if (width === 390) await page.keyboard.press("Escape");
      await page.locator("html").evaluate((el, value) => { el.dataset.theme = value; }, theme);
      const unavailable = section.locator('[data-tabs-demo="unavailable"]');
      const blocked = unavailable.getByRole("link", { name: "아웃라인", exact: true });
      await expect(blocked).toHaveAttribute("aria-disabled", "true");
      expect(await unavailable.getByRole("navigation").evaluate(el => el.getBoundingClientRect().height)).toBeLessThanOrEqual(56);
      await blocked.focus();
      await expect(blocked).toBeFocused();
      await expect(blocked).toHaveAccessibleDescription("먼저 설정을 완료합니다");
      const before = page.url();
      await blocked.press("Enter");
      await blocked.click({ force: true });
      expect(page.url()).toBe(before);
      await expect(blocked).not.toHaveAttribute("href");
      await expect(unavailable.locator('[aria-current="page"]')).toHaveAccessibleName("목록");
      expect(await section.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      expect(await section.getByRole("tablist").evaluateAll(lists => lists.every(el => el.scrollWidth <= el.clientWidth))).toBe(true);
      const { violations } = await new AxeBuilder({ page }).include("[data-tabs-gallery]").withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
      expect(violations).toEqual([]);
      await section.screenshot({ path: info.outputPath(`tabs-${width}-${theme}.png`), animations: "disabled" });
    });
  }
}
