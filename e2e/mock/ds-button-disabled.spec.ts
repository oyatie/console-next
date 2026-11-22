// SPDX-License-Identifier: LicenseRef-Proprietary
import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { EXPERIENCE_KEY } from "../../apps/web/src/lib/prefs";
import { expectAxe, fits } from "../a11y";
import { mockNavigate } from "./navigation";

const SHOTS_DIR = process.env.STRUCT_SHOTS;

const ENTRIES = ["button", "disabled-reason"] as const;

for (const entry of ENTRIES) {
  test(`${entry} gallery renders disabled buttons with solid borders (zero dashed) in Console across 1440/390 light/dark`, async ({
    page,
  }) => {
    if (SHOTS_DIR) mkdirSync(SHOTS_DIR, { recursive: true });
    await page.addInitScript(
      ({ expKey }) => {
        localStorage.setItem(expKey, "console");
        localStorage.setItem("console.theme", "light");
      },
      { expKey: EXPERIENCE_KEY },
    );

    await page.setViewportSize({ width: 1440, height: 900 });
    await mockNavigate(page, `/_gallery?entry=${entry}`);
    await expect(page.locator("html")).toHaveAttribute("data-experience", "console");

    const disabledStyles = await page.evaluate(() => {
      const buttons = [...document.querySelectorAll<HTMLButtonElement>('button[disabled], button[aria-disabled="true"]')];
      return buttons.map(btn => {
        const cs = getComputedStyle(btn);
        return {
          text: btn.textContent?.trim() ?? "",
          borderTopStyle: cs.borderTopStyle,
          borderRightStyle: cs.borderRightStyle,
          borderBottomStyle: cs.borderBottomStyle,
          borderLeftStyle: cs.borderLeftStyle,
          opacity: cs.opacity,
          cursor: cs.cursor,
        };
      });
    });

    expect(disabledStyles.length).toBeGreaterThan(0);
    for (const style of disabledStyles) {
      expect(style.borderTopStyle, style.text).toBe("solid");
      expect(style.borderRightStyle, style.text).toBe("solid");
      expect(style.borderBottomStyle, style.text).toBe("solid");
      expect(style.borderLeftStyle, style.text).toBe("solid");
      expect(style.cursor, style.text).toBe("not-allowed");
    }

    await expectAxe(page, `${entry} console 1440`);

    for (const width of [1440, 390] as const) {
      const height = width === 1440 ? 900 : 844;
      await page.setViewportSize({ width, height });
      await fits(page, `${entry} console ${width}`);
      for (const theme of ["light", "dark"] as const) {
        await page.locator("html").evaluate((el, mode) => {
          el.dataset.theme = mode;
        }, theme);
        if (SHOTS_DIR) {
          await page.screenshot({
            path: path.join(SHOTS_DIR, `${entry}--${width}-${theme}.png`),
            fullPage: true,
          });
        }
      }
    }

    await page.setViewportSize({ width: 390, height: 844 });
    await expectAxe(page, `${entry} console 390`);
  });
}
