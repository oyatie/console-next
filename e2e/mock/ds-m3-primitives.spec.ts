// SPDX-License-Identifier: LicenseRef-Proprietary
import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { EXPERIENCE_KEY } from "../../apps/web/src/lib/prefs";
import { expectAxe, fits } from "../a11y";
import { mockNavigate } from "./navigation";

const SHOTS_DIR = process.env.STRUCT_SHOTS ?? "/tmp/ds-m3-shots";

const ENTRIES = [
  { entry: "period-stepper", selector: "[data-period-stepper-gallery]" },
  { entry: "ledger", selector: "[data-ledger-gallery]" },
  { entry: "meter", selector: "[data-meter-gallery]" },
] as const;

for (const { entry, selector } of ENTRIES) {
  test(`${entry} gallery renders in Console mode across 1440/390 light/dark with zero axe or overflow issues`, async ({ page }) => {
    mkdirSync(SHOTS_DIR, { recursive: true });
    await page.addInitScript(
      ({ expKey }) => {
        localStorage.setItem(expKey, "console");
        localStorage.setItem("console.theme", "light");
      },
      { expKey: EXPERIENCE_KEY },
    );
    await page.setViewportSize({ width: 1440, height: 900 });
    await mockNavigate(page, `/_gallery?entry=${entry}`);
    const section = page.locator(selector);
    await expect(section).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-experience", "console");

    if (entry === "period-stepper") {
      const boxed = section.locator('[data-variant="boxed"]');
      const label = boxed.locator("strong");
      const initial = await label.innerText();
      await boxed.locator("button").first().click();
      await expect(label).not.toHaveText(initial);
      await boxed.locator("button").last().click();
      await expect(label).toHaveText(initial);
    }

    if (entry === "meter") {
      const cells = section.locator('[data-segmented="true"]').first().locator('[data-state]');
      await expect(cells).toHaveCount(30);
    }

    await expectAxe(page, `${entry} console 1440`, { include: selector });

    for (const width of [1440, 390] as const) {
      const height = width === 1440 ? 900 : 844;
      await page.setViewportSize({ width, height });
      if (width === 390) await fits(page, `${entry} console 390`);
      for (const theme of ["light", "dark"] as const) {
        await page.locator("html").evaluate((el, mode) => {
          el.dataset.theme = mode;
        }, theme);
        await page.screenshot({
          path: path.join(SHOTS_DIR, `${entry}--${width}-${theme}.png`),
          fullPage: true,
        });
      }
    }

    await page.setViewportSize({ width: 390, height: 844 });
    await expectAxe(page, `${entry} console 390`, { include: selector });
  });
}
