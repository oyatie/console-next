// SPDX-License-Identifier: LicenseRef-Proprietary
import { tg } from "@console/i18n/gallery";
import { afterAll, beforeAll, expect, test } from "vitest";
import type { MountedGallery } from "../../lib/gallery-browser-test";
import { expectFitsViewport, expectPatternMatrixClean, openPatternFixture } from "./pattern-browser-helpers";

let mounted: MountedGallery;

beforeAll(async () => {
  mounted = await openPatternFixture("form");
}, 60_000);

afterAll(async () => {
  await mounted?.close();
});

test("Form pattern passes WCAG 2.2 AA matrix, fits side-by-side DateFields at 390px and 320px, and updates Meter/consequence", async () => {
  const { page } = mounted;
  await expectPatternMatrixClean(page);

  for (const width of [390, 320] as const) {
    await expectFitsViewport(page, width);
    const pairBoxes = await page.locator("input[type='text']").evaluateAll(els =>
      els.map(el => {
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top };
      }),
    );
    expect(pairBoxes).toHaveLength(2);
    expect(pairBoxes[0]!.right).toBeLessThanOrEqual(pairBoxes[1]!.left);
    expect(pairBoxes[1]!.right).toBeLessThanOrEqual(width);
  }

  await page.getByText(tg("pat.form.halfAm")).click();
  expect(await page.locator('[role="meter"]').getAttribute("aria-valuetext")).toMatch(/5\.5/);
  expect(await page.locator("button[type='submit']").getAttribute("data-submitted")).toBe("0");
  await page.locator("button[type='submit']").click();
  expect(await page.locator("button[type='submit']").getAttribute("data-submitted")).toBe("1");
}, 45_000);
