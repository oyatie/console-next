// SPDX-License-Identifier: LicenseRef-Proprietary
import { afterAll, beforeAll, expect, test } from "vitest";
import { mountBrowserModule, type MountedGallery } from "../../../lib/gallery-browser-test";

let mounted: MountedGallery;

// A scrolling grid that has not drawn its rows yet, as a virtual table is on its first frame after Back.
beforeAll(async () => {
  mounted = await mountBrowserModule({
    slug: "rows-drawn-test",
    readySelector: "[data-grid]",
    viewport: { width: 1280, height: 800 },
    moduleCode: `
      import { whenRowsDrawn } from '/apps/web/src/features/people/ui/rows-drawn.ts';
      const grid = document.createElement('div');
      grid.dataset.grid = '';
      grid.style.cssText = 'height: 200px; overflow: auto';
      document.getElementById('root').append(grid);
      window.drawRows = () => {
        for (let i = 0; i < 40; i++) {
          const row = document.createElement('div');
          row.dataset.rowId = String(i);
          row.style.height = '40px';
          grid.append(row);
        }
      };
      window.restore = top => new Promise(resolve => whenRowsDrawn(grid, () => { grid.scrollTop = top; resolve(grid.scrollTop); }));
    `,
  });
}, 60_000);

afterAll(async () => {
  await mounted?.close();
});

// Setting the position before the rows exist leaves the grid at the top; the roster returns where the person left it.
test("a grid's position is put back once its rows are drawn, not before", async () => {
  const { page } = mounted;
  const top = await page.evaluate(async () => {
    const w = window as unknown as { restore: (top: number) => Promise<number>; drawRows: () => void };
    const restored = w.restore(600);
    await new Promise(requestAnimationFrame);
    w.drawRows();
    return restored;
  });
  expect(top).toBe(600);
  // Once drawn, a later restore applies at once.
  expect(await page.evaluate(() => (window as unknown as { restore: (top: number) => Promise<number> }).restore(320))).toBe(320);
});
