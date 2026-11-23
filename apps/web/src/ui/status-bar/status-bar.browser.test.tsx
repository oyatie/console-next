// SPDX-License-Identifier: LicenseRef-Proprietary
import { afterAll, beforeAll, expect, test } from "vitest";
import { mountGalleryEntry, scanWcag22Matrix, type MountedGallery } from "../../lib/gallery-browser-test";

let mounted: MountedGallery;

beforeAll(async () => {
  mounted = await mountGalleryEntry({
    name: "status-bar",
    entryPath: "/apps/web/src/ui/status-bar/status-bar.gallery.tsx",
    readySelector: "[data-status-bar-gallery]",
  });
}, 60_000);

afterAll(async () => {
  await mounted?.close();
});

test("StatusBar passes WCAG 2.2 AA axe checks and renders 24px high on Console desktop", async () => {
  const { page } = mounted;
  expect(await scanWcag22Matrix(page)).toEqual([]);

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => {
    document.documentElement.dataset.experience = "console";
    document.documentElement.dataset.theme = "light";
  });
  const height = await page
    .locator("footer[data-surface='chrome']")
    .evaluate(el => Math.round(el.getBoundingClientRect().height));
  expect(height).toBe(24);
});
