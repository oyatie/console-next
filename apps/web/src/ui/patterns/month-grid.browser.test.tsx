// SPDX-License-Identifier: LicenseRef-Proprietary
import { afterAll, beforeAll, expect, test } from "vitest";
import type { MountedGallery } from "../../lib/gallery-browser-test";
import { expectPatternMatrixClean, openPatternFixture, setConsoleViewport } from "./pattern-browser-helpers";

let mounted: MountedGallery;

beforeAll(async () => {
  mounted = await openPatternFixture("month-grid");
}, 60_000);

afterAll(async () => {
  await mounted?.close();
});

test("MonthGrid pattern passes WCAG 2.2 AA matrix, wraps 6-tile StatRow at 390px, and manages dock pane", async () => {
  const { page } = mounted;
  await expectPatternMatrixClean(page);

  const statBox = await page.locator("dl[aria-label]").evaluate(el => {
    const items = [...el.children].map(c => c.getBoundingClientRect());
    return {
      overflow: el.scrollWidth - el.clientWidth,
      rows: new Set(items.map(r => Math.round(r.top))).size,
    };
  });
  expect(statBox.overflow).toBeLessThanOrEqual(0);
  expect(statBox.rows).toBe(3);

  await setConsoleViewport(page, 1440, 900);
  const periodLabel = page.locator('[data-variant="boxed"] strong');
  const before = await periodLabel.innerText();
  await page.locator('[data-variant="boxed"] button').first().click();
  expect(await periodLabel.innerText()).not.toBe(before);

  await page.locator('tbody tr[data-id="10587"]').click();
  await page.locator('[data-pane="record"]').waitFor();
  expect(await page.locator('[data-pane="record"]').count()).toBe(1);
  await page.getByRole("complementary").getByRole("button").first().focus();
  await page.keyboard.press("Escape");
  expect(await page.locator('[data-pane="record"]').count()).toBe(0);
}, 45_000);
