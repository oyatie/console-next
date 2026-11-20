// SPDX-License-Identifier: LicenseRef-Proprietary
import { afterAll, beforeAll, expect, test } from "vitest";
import { loadCatalog } from "@console/i18n";
import { mountGalleryEntry, scanWcag22Matrix, type MountedGallery } from "../../lib/gallery-browser-test";

let mounted: MountedGallery;

beforeAll(async () => {
  await loadCatalog("ko");
  mounted = await mountGalleryEntry({
    name: "meter",
    entryPath: "/apps/web/src/ui/meter/meter.gallery.tsx",
    readySelector: "[data-meter-gallery]",
  });
}, 60_000);

afterAll(async () => {
  await mounted?.close();
});

test("Meter passes WCAG 2.2 AA axe checks and renders 30 equal cells across container width", async () => {
  const { page } = mounted;
  expect(await scanWcag22Matrix(page)).toEqual([]);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => {
    document.documentElement.dataset.experience = "console";
    document.documentElement.dataset.theme = "light";
  });

  const metrics = await page.evaluate(() => {
    const segmented = document.querySelectorAll('[data-segmented="true"]')[0]!;
    const cells = [...segmented.children];
    const used = cells.filter(c => c.getAttribute("data-state") === "used").length;
    const pending = cells.filter(c => c.getAttribute("data-state") === "pending").length;
    const rest = cells.filter(c => c.getAttribute("data-state") === "rest").length;
    const meterBox = segmented.getBoundingClientRect();
    const lastBox = cells.at(-1)!.getBoundingClientRect();
    const partial = document.querySelectorAll('[data-segmented="true"]')[1]!;
    const partialUsed = partial.querySelector('[data-state="partial-used"]');
    return {
      total: cells.length,
      used,
      pending,
      rest,
      fillsContainer: Math.abs(lastBox.right - meterBox.right) <= 1,
      meterHeight: meterBox.height,
      partialPct: partialUsed ? getComputedStyle(partialUsed).getPropertyValue("--pct").trim() : null,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });

  expect(metrics.total).toBe(30);
  expect(metrics.used).toBe(11);
  expect(metrics.pending).toBe(2);
  expect(metrics.rest).toBe(17);
  expect(metrics.fillsContainer).toBe(true);
  expect(metrics.meterHeight).toBeCloseTo(16, 0);
  expect(metrics.partialPct).toBe("50%");
  expect(metrics.overflow).toBe(0);
});
