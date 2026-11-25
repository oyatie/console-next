// SPDX-License-Identifier: LicenseRef-Proprietary
import { afterAll, beforeAll, expect, test } from "vitest";
import { mountGalleryEntry, scanWcag22Matrix, type MountedGallery } from "../../lib/gallery-browser-test";

let mounted: MountedGallery;

beforeAll(async () => {
  mounted = await mountGalleryEntry({
    name: "due-cell",
    entryPath: "/apps/web/src/ui/due-cell/due-cell.gallery.tsx",
    readySelector: "[data-due-cell-gallery]",
  });
}, 60_000);

afterAll(async () => {
  await mounted?.close();
});

test("DueCell passes WCAG 2.2 AA axe checks across all five tones", async () => {
  const { page } = mounted;
  expect(await scanWcag22Matrix(page)).toEqual([]);
  const tones = await page.locator("data[data-tone]").evaluateAll(els => els.map(el => el.getAttribute("data-tone")));
  expect(tones).toEqual(["over", "today", "near", "far", "undated"]);
});

test("on Console the today cell takes the warn roles", async () => {
  const { page } = mounted;
  await page.setViewportSize({ width: 1440, height: 900 });
  const today = await page.evaluate(() => {
    document.documentElement.dataset.experience = "console";
    document.documentElement.dataset.theme = "light";
    const s = getComputedStyle(document.querySelector<HTMLElement>('data[data-tone="today"]')!);
    return { fill: s.backgroundColor, text: s.color };
  });
  expect(today).toEqual({ fill: "rgb(253, 240, 213)", text: "rgb(138, 79, 0)" });
});
