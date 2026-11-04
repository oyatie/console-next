// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { expectAxe, fits } from "../a11y";
import { orgWorkReads } from "../mock/org-work";
import { mockRoute } from "../mock/route";
import { mockScreen } from "../mock/screen";
import { entityRecord } from "./entity-record";
import { screens } from "./registry";

test.beforeAll(() => loadCatalog("ko"));

for (const state of ["populated", "long"] as const) for (const width of [1440, 390]) {
  test(`bulk tables keep selection visible and clipped columns reachable: ${state}, ${width}px @ui-state`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const fixture = await mockScreen(page, screens.find(s => s.key === "org")!, "populated");
    await orgWorkReads(page, "operating");
    const entity = entityRecord(state);
    await mockRoute(page, "get", "/api/v1/legal-entities", { status: 200, json: { items: [entity] } });
    await mockRoute(page, "get", "/api/v1/workplace-kinds", { status: 200, json: { items: [] } });
    try {
      await page.goto("/org/workplaces/edit");
      const table = page.getByRole("main").getByRole("table");
      const selectAll = table.locator("thead").getByRole("checkbox");
      if (width === 390) {
        const label = table.getByText(t("uiLongTable.selection.toggleAll", { count: 1, unit: "item" }), { exact: true });
        await expect(label).toBeVisible();
        const [box, labelBox] = await Promise.all([selectAll.boundingBox(), label.boundingBox()]);
        expect(Math.min(box!.width, box!.height)).toBeGreaterThanOrEqual(16);
        expect(labelBox!.width).toBeGreaterThan(labelBox!.height * 2);
      }
      await selectAll.check();
      await page.getByRole("button", { name: t("orgBulk.edit.open", { count: 1 }), exact: true }).click();
      const dialog = page.getByRole("dialog", { name: t("orgBulk.edit.title", { count: 1 }), exact: true });
      const preview = dialog.getByRole("table", { name: t("orgBulk.edit.rows"), exact: true });
      const scroller = preview.locator("xpath=..");
      const cue = dialog.locator("[data-scroll-cue]");
      await expect(preview.locator("tbody > tr").first()).toHaveCSS("display", "table-row");
      await expect(dialog.getByRole("region", { name: t("orgBulk.edit.rows"), exact: true })).toHaveCount(0);
      await expect(scroller).not.toHaveAttribute("tabindex", /.+/);
      if (width === 390) {
        expect(await scroller.evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
        await expect(cue).toBeVisible();
        await expect(preview).toHaveAttribute("tabindex", "0");
        await preview.focus();
        await preview.press("ArrowRight");
        await expect.poll(() => scroller.evaluate(el => el.scrollLeft)).toBeGreaterThan(0);
        await scroller.evaluate(el => { el.scrollLeft = el.scrollWidth; });
        await expect(cue).toHaveCount(0);
      } else {
        await expect(preview).not.toHaveAttribute("tabindex", /.+/);
        await expect(cue).toHaveCount(0);
      }
      await fits(page, `bulk table/${state}/${width}`);
      await expectAxe(page, `bulk table/${state}/${width}`);
      expect(fixture.unexpected).toEqual([]);
    } finally { await page.close(); fixture.release(); }
  });
}
