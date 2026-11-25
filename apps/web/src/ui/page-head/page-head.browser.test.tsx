// SPDX-License-Identifier: LicenseRef-Proprietary
import { afterAll, beforeAll, expect, test } from "vitest";
import { tg } from "@console/i18n/gallery";
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
      const heading = header.querySelector("h1, h2")!;
      return {
        titleFontSize: getComputedStyle(heading).fontSize,
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

test("Console: a title wider than the strip wraps inside the head, and a title that fits keeps one line", async () => {
  const { page } = mounted;
  await page.setViewportSize({ width: 1024, height: 900 });
  await page.evaluate(() => { document.documentElement.dataset.experience = "console"; });
  const header = page.locator("[data-page-head-demo='command'] header");
  const title = header.locator("h1, h2");
  const lines = () => title.evaluate(el => {
    const range = document.createRange();
    range.selectNodeContents(el);
    return new Set([...range.getClientRects()].map(rect => Math.round(rect.top))).size;
  });
  expect(await lines()).toBe(1);
  await title.evaluate((el, text) => { el.textContent = text; }, tg("sample.longName").repeat(4));
  expect(await lines()).toBeGreaterThan(1);
  expect(await header.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
});
