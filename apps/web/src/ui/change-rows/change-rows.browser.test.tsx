// SPDX-License-Identifier: LicenseRef-Proprietary
import { afterAll, beforeAll, expect, test } from "vitest";
import { mountGalleryEntry, scanWcag22Matrix, type MountedGallery } from "../../lib/gallery-browser-test";

let mounted: MountedGallery;

beforeAll(async () => {
  mounted = await mountGalleryEntry({
    name: "change-rows",
    entryPath: "/apps/web/src/ui/change-rows/change-rows.gallery.tsx",
    readySelector: "[data-change-rows-gallery]",
  });
}, 60_000);

afterAll(async () => {
  await mounted?.close();
});

test("ChangeRows passes WCAG 2.2 AA axe checks and renders two diff rows", async () => {
  const { page } = mounted;
  expect(await scanWcag22Matrix(page)).toEqual([]);
  expect(await page.locator("[data-change-rows] dt").count()).toBe(2);
});
