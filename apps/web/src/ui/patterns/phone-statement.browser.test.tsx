// SPDX-License-Identifier: LicenseRef-Proprietary
import { afterAll, beforeAll, expect, test } from "vitest";
import type { MountedGallery } from "../../lib/gallery-browser-test";
import { expectFitsViewport, expectPatternMatrixClean, openPatternFixture } from "./pattern-browser-helpers";

let mounted: MountedGallery;

beforeAll(async () => {
  mounted = await openPatternFixture("phone-statement");
}, 60_000);

afterAll(async () => {
  await mounted?.close();
});

test("PhoneStatement passes WCAG 2.2 AA matrix, steps period, and avoids overflow at 390px and 320px", async () => {
  const { page } = mounted;
  await expectPatternMatrixClean(page);
  await expectFitsViewport(page, 320);

  const label = page.locator('[data-variant="plain"] strong');
  const initial = await label.innerText();
  await page.locator('[data-variant="plain"] button').first().click();
  expect(await label.innerText()).not.toBe(initial);
  await page.locator('[data-variant="plain"] button').last().click();
  expect(await label.innerText()).toBe(initial);
}, 45_000);
