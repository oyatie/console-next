// SPDX-License-Identifier: LicenseRef-Proprietary
import { afterAll, beforeAll, expect, test } from "vitest";
import { mountGalleryEntry, scanWcag22Matrix, type MountedGallery } from "../../lib/gallery-browser-test";

let mounted: MountedGallery;

beforeAll(async () => {
  mounted = await mountGalleryEntry({
    name: "page-head",
    entryPath: "/apps/web/src/ui/page-head/page-head.gallery.tsx",
    readySelector: "[data-page-head-gallery]",
  });
}, 60_000);

afterAll(async () => {
  await mounted?.close();
});

test("PageHead command strip passes WCAG 2.2 AA axe checks and sizes title and band height per experience", async () => {
  const { page } = mounted;
  expect(await scanWcag22Matrix(page)).toEqual([]);

  await page.setViewportSize({ width: 1440, height: 900 });
  for (const experience of ["baseline", "console"] as const) {
    await page.evaluate(exp => {
      document.documentElement.dataset.experience = exp;
      document.documentElement.dataset.theme = "light";
    }, experience);
    const metrics = await page.locator("[data-page-head-demo='command'] header").evaluate(header => {
      const h1 = header.querySelector("h1")!;
      return {
        titleFontSize: getComputedStyle(h1).fontSize,
        minHeight: getComputedStyle(header).minHeight,
      };
    });
    if (experience === "baseline") {
      expect(metrics.titleFontSize).toBe("20px");
    } else {
      expect(metrics.titleFontSize).toBe("15px");
      expect(metrics.minHeight).toBe("40px");
    }
  }
});
