// SPDX-License-Identifier: LicenseRef-Proprietary
import { afterAll, beforeAll, expect, test } from "vitest";
import { mountGalleryEntry, scanWcag22Matrix, type MountedGallery } from "../../lib/gallery-browser-test";

let mounted: MountedGallery;

beforeAll(async () => {
  mounted = await mountGalleryEntry({
    name: "deadline-strip",
    entryPath: "/apps/web/src/ui/deadline-strip/deadline-strip.gallery.tsx",
    readySelector: "[data-deadline-strip-gallery]",
  });
}, 60_000);

afterAll(async () => {
  await mounted?.close();
});

test("DeadlineStrip passes WCAG 2.2 AA axe checks and updates pressed pill selection", async () => {
  const { page } = mounted;
  expect(await scanWcag22Matrix(page)).toEqual([]);

  const statutoryBtn = page.locator('[data-deadline-strip] button[data-lane="statutory"]');
  await statutoryBtn.click();
  expect(await statutoryBtn.getAttribute("aria-pressed")).toBe("true");
});
