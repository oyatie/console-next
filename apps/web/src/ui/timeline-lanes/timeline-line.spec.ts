import { expect, test } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
import { timelineStates } from "./states";
import { bootKo } from "../../../../../packages/i18n/src/catalogs/boot";
import { koTimeline } from "../../../../../packages/i18n/src/catalogs/ko/timeline";
import { tg } from "../../../../../packages/i18n/src/gallery";

for (const theme of ["light", "dark"] as const) {
  for (const width of [1280, 390]) {
    test(`timeline lifecycle at ${width}px, ${theme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme });
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/_gallery");
      const gallery = page.locator("#gallery-timeline-line");
      await expect(gallery).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      // Unrelated error-copy wrapping must not change the timeline's screenshot pixel phase.
      const errors = page.locator(".gallery__section").filter({ has: page.getByRole("heading", { name: tg("section.errors"), exact: true }) });
      await errors.evaluate((section) => { section.style.height = `${Math.ceil(section.getBoundingClientRect().height)}px`; });
      for (const state of timelineStates) {
        const line = page.locator(`#gallery-timeline-${state}`);
        await expect(line).toContainText(({ ...bootKo, ...koTimeline })[`timeline.state.${state}`]);
        await expect(line).toHaveScreenshot(`timeline-${state}-${width}-${theme}.png`, { animations: "disabled" });
      }
      for (const state of ["retained", "due", "hold", "destroyed"]) {
        await expect(page.locator(`#gallery-retention-${state}`)).toHaveScreenshot(`retention-${state}-${width}-${theme}.png`);
      }
      const restricted = page.locator("#gallery-timeline-restricted");
      const destroyed = page.locator("#gallery-timeline-destroyed");
      for (const line of [restricted, destroyed]) {
        await expect(line.locator("dl, details, button, a")).toHaveCount(0);
      }
      await expect(page.locator("#gallery-timeline-corrected del").first()).toBeVisible();
      const axe = await new AxeBuilder({ page }).include("#gallery-timeline-line").analyze();
      expect(axe.violations).toEqual([]);

      // Enter/Tab opens the long diff; Space closes it without leaving the history row.
      const changed = page.locator("#gallery-timeline-changed");
      await changed.focus();
      await page.keyboard.press("Tab");
      const summary = changed.locator("summary").first();
      await expect(summary).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(changed.locator("details").first()).toHaveAttribute("open", "");
      await expect(changed).toHaveScreenshot(`timeline-long-expanded-${width}-${theme}.png`, { animations: "disabled" });
      await page.keyboard.press("Space");
      await expect(changed.locator("details").first()).not.toHaveAttribute("open", "");
    });
  }
}
