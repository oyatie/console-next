// SPDX-License-Identifier: LicenseRef-Proprietary
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { mountBrowserModule, mountGalleryEntry, scanWcag22Matrix, type MountedGallery } from "../../lib/gallery-browser-test";

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

test("ChangeRows passes WCAG 2.2 AA axe checks, resets dd margin, and renders two diff rows", async () => {
  const { page } = mounted;
  expect(await scanWcag22Matrix(page)).toEqual([]);
  expect(await page.locator("[data-change-rows] dt").count()).toBe(2);

  const ddMargins = await page.evaluate(() =>
    [...document.querySelectorAll("[data-change-rows] dd")].map(el => getComputedStyle(el).marginInlineStart),
  );
  expect(ddMargins.length).toBe(6);
  for (const margin of ddMargins) expect(margin).toBe("0px");
});

describe("ChangeRows narrow containment and hairline alignment", () => {
  let narrow: MountedGallery;

  beforeAll(async () => {
    narrow = await mountBrowserModule({
      slug: "change-rows-narrow-test",
      readySelector: "[data-change-rows]",
      viewport: { width: 390, height: 900 },
      moduleCode: `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { loadCatalog } from '@console/i18n';
        import { ChangeRows } from '/apps/web/src/ui/change-rows/change-rows.tsx';
        import '/apps/web/src/app.css';
        await loadCatalog('ko');
        createRoot(document.getElementById('root')).render(
          React.createElement('main', null,
            React.createElement('div', { 'data-pane-box': '', style: { width: '280px', maxWidth: '100%', border: '1px solid var(--border)' } },
              React.createElement(ChangeRows, {
                items: [
                  {
                    id: 'long-1',
                    subject: 'SUPER_LONG_UNBROKEN_SUBJECT_IDENTIFIER_FOR_280PX_PANE',
                    before: 'UNBROKEN_BEFORE_IDENTIFIER_VALUE_0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ',
                    after: 'UNBROKEN_AFTER_IDENTIFIER_VALUE_0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ',
                  },
                  {
                    id: 'short-2',
                    subject: 'Team',
                    before: '18',
                    after: '30',
                  },
                ],
              }),
            ),
          ),
        );
      `,
    });
  }, 60_000);

  afterAll(async () => {
    await narrow?.close();
  });

  test("fits 280px side pane and 390px viewport without overflow and aligns wrapped row bottoms", async () => {
    const { page } = narrow;
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      const metrics = await page.evaluate(() => {
        const list = document.querySelector("[data-change-rows]") as HTMLElement;
        const pane = document.querySelector("[data-pane-box]") as HTMLElement;
        const firstRowCells = [...list.querySelectorAll(":scope > div:first-child > *")].map(el => ({
          tag: el.tagName,
          bottom: Math.round(el.getBoundingClientRect().bottom * 10) / 10,
          marginInlineStart: getComputedStyle(el).marginInlineStart,
        }));
        return {
          listScrollW: list.scrollWidth,
          listClientW: list.clientWidth,
          paneScrollW: pane.scrollWidth,
          paneClientW: pane.clientWidth,
          docScrollW: document.documentElement.scrollWidth,
          docClientW: document.documentElement.clientWidth,
          firstRowCells,
        };
      });
      expect(metrics.listScrollW).toBeLessThanOrEqual(metrics.listClientW);
      expect(metrics.paneScrollW).toBeLessThanOrEqual(metrics.paneClientW);
      expect(metrics.docScrollW).toBeLessThanOrEqual(metrics.docClientW);
      const bottoms = metrics.firstRowCells.map(c => c.bottom);
      expect(bottoms).toHaveLength(4);
      for (const bottom of bottoms) expect(Math.abs(bottom - bottoms[0]!)).toBeLessThanOrEqual(0.5);
      for (const cell of metrics.firstRowCells) expect(cell.marginInlineStart).toBe("0px");
    }
  });
});
