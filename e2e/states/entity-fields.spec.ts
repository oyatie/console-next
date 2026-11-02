// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { expectAxe, fits } from "../a11y";
import { mockRoute } from "../mock/route";
import { orgPanelReads } from "../mock/org-work";
import { id } from "../mock/fixtures";
import { entityRecordPath, mockEntityRecord } from "./entity-record";
import { mockScreen } from "../mock/screen";
import { screens } from "./registry";

test.beforeAll(() => loadCatalog("ko"));

for (const surface of ["record", "workplace", "chart"] as const) for (const width of [1440, 390]) {
  test(`entity fields: ${surface} has one edit per row and one empty marker (${width}px) @ui-state`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const fixture = surface === "chart" ? await mockScreen(page, screens[2], "populated") : await mockEntityRecord(page, "populated");
    let release = () => {};
    try {
      if (surface === "chart") {
        release = (await orgPanelReads(page)).release;
        await mockRoute(page, "get", "/api/v1/org-structure/units/{orgUnitId}/members", { status: 200, json: { headcount: 0, items: [] } });
      }
      await page.goto(surface === "chart" ? `/org?sel=${id(4)}` : surface === "workplace" ? `${entityRecordPath}?wp=${id(4102)}` : entityRecordPath);
      const main = surface === "chart" ? page.getByRole("complementary", { name: "본사", exact: true }) : page.getByRole("main");
      const rows = surface === "record" ? main.locator('[class*="_fact_"]') : main.locator('dl > div').filter({ has: page.locator("dt") });
      await expect(rows.first()).toBeVisible();
      const buttons = rows.getByRole("button");
      await expect(buttons.first()).toBeEnabled();
      expect(await rows.evaluateAll(elements => elements.filter(row => row.querySelectorAll("button").length > 1).map(row => row.textContent))).toEqual([]);
      for (const button of await buttons.all()) await expect(button).toHaveText(t("entityRecord.action.fix"));
      const emptyFields = surface === "record" ? ["entityRecord.field.liquor", "entityRecord.vat.mainKsic"] as const : ["workplace.create.kind", "workplace.code.field"] as const;
      for (const key of emptyFields) {
        const row = rows.filter({ hasText: t(key) });
        const value = surface === "record" ? row.locator('[class*="_factValue_"]') : row.locator("dd").first();
        await expect(value).toHaveText("—");
      }
      for (const theme of ["light", "dark"]) {
        await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
        await page.screenshot({ path: test.info().outputPath(`${surface}-${width}-${theme}.png`), fullPage: true });
        await fits(page, `entity fields/${surface}/${width}/${theme}`);
        await expectAxe(page, `entity fields/${surface}/${width}/${theme}`);
      }
      expect(fixture.unexpected).toEqual([]);
    } finally { release(); await page.close(); fixture.release(); }
  });
}
