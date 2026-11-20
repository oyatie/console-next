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
  const overBtn = page.locator('[data-deadline-strip] button[data-tone="over"]');
  const todayBtn = page.locator('[data-deadline-strip] button[data-tone="today"]');
  const unselectedOverBg = await overBtn.evaluate(el => getComputedStyle(el).backgroundColor);
  const unselectedTodayBg = await todayBtn.evaluate(el => getComputedStyle(el).backgroundColor);

  await statutoryBtn.click();
  expect(await statutoryBtn.getAttribute("aria-pressed")).toBe("true");
  expect(await statutoryBtn.getAttribute("data-selected")).toBe("true");
  const selectedPrimaryBg = await statutoryBtn.evaluate(el => getComputedStyle(el).backgroundColor);

  await overBtn.click();
  expect(await overBtn.getAttribute("aria-pressed")).toBe("true");
  expect(await overBtn.getAttribute("data-selected")).toBe("true");
  const selectedOverBg = await overBtn.evaluate(el => getComputedStyle(el).backgroundColor);
  expect(selectedOverBg).toBe(selectedPrimaryBg);
  expect(selectedOverBg).not.toBe(unselectedOverBg);

  await todayBtn.click();
  expect(await todayBtn.getAttribute("aria-pressed")).toBe("true");
  expect(await todayBtn.getAttribute("data-selected")).toBe("true");
  const selectedTodayBg = await todayBtn.evaluate(el => getComputedStyle(el).backgroundColor);
  expect(selectedTodayBg).toBe(selectedPrimaryBg);
  expect(selectedTodayBg).not.toBe(unselectedTodayBg);
});
