// SPDX-License-Identifier: LicenseRef-Proprietary
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { mountBrowserModule, mountGalleryEntry, scanWcag22Matrix, type MountedGallery } from "../../lib/gallery-browser-test";

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

describe("DeadlineStrip WCAG 2.5.3 label-in-name and single region", () => {
  let a11y: MountedGallery;

  beforeAll(async () => {
    a11y = await mountBrowserModule({
      slug: "deadline-strip-a11y-test",
      lang: "en",
      readySelector: "[data-deadline-strip]",
      viewport: { width: 1440, height: 900 },
      moduleCode: `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { loadCatalog } from '@console/i18n';
        import { DeadlineStrip } from '/apps/web/src/ui/deadline-strip/deadline-strip.tsx';
        import '/apps/web/src/app.css';
        await loadCatalog('en');
        createRoot(document.getElementById('root')).render(
          React.createElement('main', null,
            React.createElement(DeadlineStrip, {
              monthLabel: '11',
              days: [
                { date: '2026-11-10', dayLabel: '10', bucket: 'today' },
                { date: '2026-11-12', dayLabel: '12', bucket: 'upcoming' },
              ],
              entries: [
                { id: 'st', shortLabel: 'ST', fullLabel: 'Statutory Today', lane: 'statutory', date: '2026-11-10' },
                { id: 'd1', shortLabel: 'D1', fullLabel: 'D10 item', lane: 'operational', date: '2026-11-12', tone: 'upcoming' },
              ],
            }),
          ),
        );
      `,
    });
  }, 60_000);

  afterAll(async () => {
    await a11y?.close();
  });

  test("passes WCAG 2.2 AA axe checks for ST / Statutory Today and D1 / D10 item with single region landmark", async () => {
    const { page } = a11y;
    expect(await scanWcag22Matrix(page)).toEqual([]);
    expect(await page.locator('[data-deadline-strip] [role="region"]').count()).toBe(1);
    expect(await page.locator("section[data-deadline-strip][aria-label]").count()).toBe(0);
  });
});
