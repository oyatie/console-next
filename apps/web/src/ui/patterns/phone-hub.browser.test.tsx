// SPDX-License-Identifier: LicenseRef-Proprietary
import { afterAll, beforeAll, expect, test } from "vitest";
import type { MountedGallery } from "../../lib/gallery-browser-test";
import { expectFitsViewport, expectPatternMatrixClean, openPatternFixture } from "./pattern-browser-helpers";

let mounted: MountedGallery;

beforeAll(async () => {
  mounted = await openPatternFixture("phone-hub");
}, 60_000);

afterAll(async () => {
  await mounted?.close();
});

test("PhoneHub passes WCAG 2.2 AA matrix and contains long-option SelectInput and Check at 390px and 320px", async () => {
  const { page } = mounted;
  await expectPatternMatrixClean(page);

  for (const width of [390, 320] as const) {
    await expectFitsViewport(page, width);
    const bounds = await page.locator('[data-pattern="phone-hub"] select').evaluate(sel => {
      const s = sel.getBoundingClientRect();
      const c = sel.closest("section")!.getBoundingClientRect();
      return { selectRight: s.right, containerRight: c.right, selectLeft: s.left, containerLeft: c.left };
    });
    expect(bounds.selectLeft).toBeGreaterThanOrEqual(bounds.containerLeft);
    expect(bounds.selectRight).toBeLessThanOrEqual(bounds.containerRight + 0.5);
  }

  const check = page.locator('[data-pattern="phone-hub"] input[type="checkbox"]');
  const appearance = await check.evaluate(el => getComputedStyle(el).appearance);
  expect(appearance).toBe("none");
  expect(await check.isChecked()).toBe(true);
  await check.click();
  expect(await check.isChecked()).toBe(false);
}, 45_000);
