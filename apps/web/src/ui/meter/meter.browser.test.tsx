// SPDX-License-Identifier: LicenseRef-Proprietary
import { afterAll, beforeAll, expect, test } from "vitest";
import { loadCatalog } from "@console/i18n";
import { mountBrowserModule, mountGalleryEntry, scanWcag22Matrix, type MountedGallery } from "../../lib/gallery-browser-test";

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
    const partialUsed = partial.querySelector('[data-state="partial-used"]')!;
    const partialPending = partial.querySelector('[data-state="partial-pending"]')!;
    const fullPending = partial.querySelector('[data-state="pending"]')!;
    const restCell = partial.querySelector('[data-state="rest"]')!;
    const pendingBg = getComputedStyle(fullPending).backgroundColor;
    const restBg = getComputedStyle(restCell).backgroundColor;
    const partialUsedBg = getComputedStyle(partialUsed).backgroundImage;
    const partialPendingBg = getComputedStyle(partialPending).backgroundImage;
    return {
      total: cells.length,
      used,
      pending,
      rest,
      fillsContainer: Math.abs(lastBox.right - meterBox.right) <= 1,
      meterHeight: meterBox.height,
      partialPct: getComputedStyle(partialUsed).getPropertyValue("--pct").trim(),
      partialPendPct: getComputedStyle(partialUsed).getPropertyValue("--pend-pct").trim(),
      partialUsedBg,
      partialPendingBg,
      pendingBg,
      restBg,
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
  expect(metrics.partialPendPct).toBe("100%");
  expect(metrics.partialUsedBg).toContain(metrics.pendingBg);
  expect(metrics.partialPendingBg).toContain(metrics.pendingBg);
  expect(metrics.partialPendingBg).toContain(metrics.restBg);
  expect(metrics.overflow).toBe(0);
});

test("Meter renders same-cell fractional used and pending stops accurately in browser", async () => {
  const edgeMount = await mountBrowserModule({
    slug: "meter-fractional-edge-test",
    readySelector: "[data-meter-edge]",
    viewport: { width: 390, height: 844 },
    moduleCode: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import '/apps/web/src/app.css';
      import { Meter } from '/apps/web/src/ui/meter/meter';
      document.documentElement.dataset.experience = 'console';
      document.documentElement.dataset.theme = 'light';
      createRoot(document.getElementById('root')).render(
        React.createElement('main', { 'data-meter-edge': '' },
          React.createElement(Meter, { value: 4.5, pending: 0.5, max: 25, cells: 30, label: 'HR 25' }),
          React.createElement(Meter, { value: 0.25, pending: 0.5, max: 1, cells: 1, label: 'Single cell' })
        )
      );
    `,
  });

  try {
    const res = await edgeMount.page.evaluate(() => {
      const [hr25, single] = [...document.querySelectorAll('[data-segmented="true"]')];
      const hrPartial = hr25!.querySelector('[data-state="partial-used"]')!;
      const singleCell = single!.querySelector('[data-state="partial-used"]')!;
      const pendingSample = hr25!.querySelector('[data-state="rest"]')!;
      return {
        hrPct: getComputedStyle(hrPartial).getPropertyValue("--pct").trim(),
        hrPendPct: getComputedStyle(hrPartial).getPropertyValue("--pend-pct").trim(),
        hrBg: getComputedStyle(hrPartial).backgroundImage,
        singlePct: getComputedStyle(singleCell).getPropertyValue("--pct").trim(),
        singlePendPct: getComputedStyle(singleCell).getPropertyValue("--pend-pct").trim(),
        singleBg: getComputedStyle(singleCell).backgroundImage,
        restBg: getComputedStyle(pendingSample).backgroundColor,
      };
    });

    expect(res.hrPct).toBe("40%");
    expect(res.hrPendPct).toBe("100%");
    expect(res.hrBg).toContain("linear-gradient");
    expect(res.singlePct).toBe("25%");
    expect(res.singlePendPct).toBe("75%");
    expect(res.singleBg).toContain(res.restBg);
  } finally {
    await edgeMount.close();
  }
});
