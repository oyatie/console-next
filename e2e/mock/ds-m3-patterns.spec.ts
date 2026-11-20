// SPDX-License-Identifier: LicenseRef-Proprietary
import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { EXPERIENCE_KEY } from "../../apps/web/src/lib/prefs";
import { expectAxe, fits } from "../a11y";
import { forgetResize } from "../stability";
import { screens } from "../states/registry";
import { mockScreen } from "./screen";

const SHOTS_DIR = process.env.STRUCT_SHOTS;

const PATTERNS_UNDER_TEST = [
  { id: "record", refusedRef: "record-refusal" },
  { id: "document-decision", refusedRef: "document-decision-refusal" },
  { id: "month-grid", refusedRef: "month-grid-refusal" },
  { id: "register-totals", refusedRef: "register-totals-refusal" },
  { id: "form", refusedRef: "form-refusal" },
  { id: "phone-hub", refusedRef: "phone-hub-refusal" },
  { id: "phone-statement", refusedRef: "phone-statement-refusal" },
] as const;

test.beforeAll(() => loadCatalog("ko"));

for (const { id, refusedRef } of PATTERNS_UNDER_TEST) {
  test(`pattern ${id} renders in Console mode across 1440/390 light/dark and refused state with zero axe or overflow issues`, async ({
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

    const fixture = await mockScreen(page, screens.find(screen => screen.key === "people")!, "populated");
    try {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`/_review/patterns/${id}`);
      const root = page.locator(`[data-pattern="${id}"]`);
      await expect(root).toBeVisible();
      await expect(page.locator("html")).toHaveAttribute("data-experience", "console");

      for (const width of [1440, 390] as const) {
        const height = width === 1440 ? 900 : 844;
        await page.setViewportSize({ width, height });
        await forgetResize(page);
        await fits(page, `${id} console ${width}`);
        for (const theme of ["light", "dark"] as const) {
          await page.locator("html").evaluate((el, mode) => {
            el.dataset.theme = mode;
          }, theme);
          await expectAxe(page, `${id} console ${width} ${theme}`);
          if (SHOTS_DIR) {
            await page.screenshot({
              path: path.join(SHOTS_DIR, `${id}--${width}-${theme}.png`),
              fullPage: true,
            });
          }
        }
      }

      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`/_review/patterns/${id}?state=refused`);
      const main = page.getByRole("main");
      await expect(main.getByRole("region", { name: t("common.denied.title.plain") })).toBeVisible();
      await expect(main).toContainText(refusedRef);
      await expect(main.getByRole("heading", { level: 1 })).toHaveCount(1);
      await fits(page, `${id} refused 390`);
      await expectAxe(page, `${id} refused 390`);
      expect(fixture.unexpected).toEqual([]);
    } finally {
      fixture.release();
    }
  });
}
