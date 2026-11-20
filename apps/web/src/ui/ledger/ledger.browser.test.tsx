// SPDX-License-Identifier: LicenseRef-Proprietary
import { afterAll, beforeAll, expect, test } from "vitest";
import { loadCatalog } from "@console/i18n";
import { mountGalleryEntry, scanWcag22Matrix, type MountedGallery } from "../../lib/gallery-browser-test";

let mounted: MountedGallery;

beforeAll(async () => {
  await loadCatalog("ko");
  mounted = await mountGalleryEntry({
    name: "ledger",
    entryPath: "/apps/web/src/ui/ledger/ledger.gallery.tsx",
    readySelector: "[data-ledger-gallery]",
  });
}, 60_000);

afterAll(async () => {
  await mounted?.close();
});

test("Ledger passes WCAG 2.2 AA axe checks and matches Console desk/phone row geometry without overflow", async () => {
  const { page } = mounted;
  expect(await scanWcag22Matrix(page)).toEqual([]);

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => {
    document.documentElement.dataset.experience = "console";
    document.documentElement.dataset.theme = "light";
  });

  const deskMetrics = await page.evaluate(() => {
    const firstLedger = document.querySelector("[data-ledger]")!;
    const itemCell = firstLedger.querySelector("tbody th")!;
    const amountCell = firstLedger.querySelector("tbody td:last-child")!;
    return {
      rowHeight: itemCell.getBoundingClientRect().height,
      tabular: getComputedStyle(amountCell).fontVariantNumeric,
    };
  });
  expect(deskMetrics.rowHeight).toBeCloseTo(24, 0);
  expect(deskMetrics.tabular).toContain("tabular-nums");

  await page.setViewportSize({ width: 390, height: 844 });
  const phoneMetrics = await page.evaluate(() => {
    const inlineLedger = document.querySelector('[data-ledger][data-detail-layout="inline"]')!;
    const itemCell = inlineLedger.querySelector("tbody th")!;
    return {
      rowHeight: itemCell.getBoundingClientRect().height,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  expect(phoneMetrics.rowHeight).toBeCloseTo(40, 0);
  expect(phoneMetrics.overflow).toBe(0);
});
