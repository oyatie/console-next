// SPDX-License-Identifier: LicenseRef-Proprietary
import { t } from "@console/i18n";
import { afterAll, beforeAll, expect, test } from "vitest";
import type { MountedGallery } from "../../lib/gallery-browser-test";
import { expectFitsViewport, expectPatternMatrixClean, openPatternFixture, setConsoleViewport } from "./pattern-browser-helpers";

let mounted: MountedGallery;

beforeAll(async () => {
  mounted = await openPatternFixture("register-totals");
}, 60_000);

afterAll(async () => {
  await mounted?.close();
});

test("RegisterTotals passes WCAG 2.2 AA matrix, filters register rows, avoids compact cell/bar overlap at 390px, and updates Ledger preview", async () => {
  const { page } = mounted;
  await expectPatternMatrixClean(page);

  await expectFitsViewport(page, 390);
  const compactGeometry = await page.locator('tbody tr[data-id="10587"]').evaluate(row => {
    const rowRect = row.getBoundingClientRect();
    const visibleCells = [...row.querySelectorAll<HTMLElement>("td")]
      .filter(td => getComputedStyle(td).display !== "none" && td.getBoundingClientRect().width > 0)
      .map(td => {
        const r = td.getBoundingClientRect();
        return { card: td.dataset.card ?? "", left: r.left, right: r.right, top: r.top, bottom: r.bottom };
      });
    const overlaps: Array<[string, string]> = [];
    for (let i = 0; i < visibleCells.length; i++) {
      for (let j = i + 1; j < visibleCells.length; j++) {
        const a = visibleCells[i]!;
        const b = visibleCells[j]!;
        const horiz = a.left < b.right - 0.5 && b.left < a.right - 0.5;
        const vert = a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
        if (horiz && vert) overlaps.push([a.card, b.card]);
      }
    }
    const firstCellLeft = visibleCells[0]?.left ?? rowRect.left;
    return { overlaps, barClearance: firstCellLeft - rowRect.left, cellCount: visibleCells.length };
  });
  expect(compactGeometry.cellCount).toBeGreaterThanOrEqual(3);
  expect(compactGeometry.overlaps).toEqual([]);
  expect(compactGeometry.barClearance).toBeGreaterThanOrEqual(8);

  await setConsoleViewport(page, 1440, 900);
  await page.locator('tbody tr[data-id="10416"]').click();
  expect(await page.locator('[data-pattern="register-totals"]').textContent()).toContain("2,559,000");

  await page.getByRole("button", { name: new RegExp(t("payroll.stage.exceptions")) }).click();
  expect(await page.locator("tbody tr[data-id]").count()).toBe(1);
}, 45_000);
