// SPDX-License-Identifier: LicenseRef-Proprietary
import { afterAll, beforeAll, expect, test } from "vitest";
import { expect as expectElement } from "@playwright/test";
import { loadCatalog } from "@console/i18n";
import { mountGalleryEntry, scanWcag22Matrix, type MountedGallery } from "../../lib/gallery-browser-test";

let mounted: MountedGallery;

beforeAll(async () => {
  await loadCatalog("ko");
  mounted = await mountGalleryEntry({
    name: "period-stepper",
    entryPath: "/apps/web/src/ui/period-stepper/period-stepper.gallery.tsx",
    readySelector: "[data-period-stepper-gallery]",
  });
}, 60_000);

afterAll(async () => {
  await mounted?.close();
});

for (const [index, unit] of ["day", "week", "month", "year"].entries()) {
  test(`${unit} arrows and current-period jump update a controlled value by keyboard`, async () => {
    const { page } = mounted;
    await page.setViewportSize({ width: 390, height: 900 });
    const period = page.getByRole("group", { name: "기간 이동", exact: true }).nth(index);
    const text = period.locator("strong"), buttons = period.getByRole("button");
    await expectElement(text).toBeVisible();
    const current = await text.innerText();
    await buttons.nth(0).focus();
    await page.keyboard.press("Enter");
    await expectElement(text).not.toHaveText(current);
    await buttons.nth(1).focus();
    await page.keyboard.press("Space");
    await expectElement(text).toHaveText(current);
    await buttons.nth(0).click();
    await expectElement(text).not.toHaveText(current);
    await buttons.nth(2).click();
    await expectElement(text).toHaveText(current);
  });
}

test("PeriodStepper passes WCAG 2.2 AA axe checks and matches boxed heights across desk and phone", async () => {
  const { page } = mounted;
  expect(await scanWcag22Matrix(page)).toEqual([]);

  const boxed = page.locator('[data-variant="boxed"]');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => {
    document.documentElement.dataset.experience = "console";
    document.documentElement.dataset.theme = "light";
  });
  const deskBox = await boxed.boundingBox();
  expect(deskBox).not.toBeNull();
  expect(deskBox!.height).toBeCloseTo(24, 0);

  await page.setViewportSize({ width: 390, height: 844 });
  const phoneBox = await boxed.boundingBox();
  expect(phoneBox).not.toBeNull();
  expect(phoneBox!.height).toBeCloseTo(44, 0);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBe(0);
});
