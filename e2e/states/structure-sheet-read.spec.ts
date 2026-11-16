// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { expectAxe, fits } from "../a11y";
import { failure, id, screenAccess } from "../mock/fixtures";
import { orgPanelReads, orgWorkReads } from "../mock/org-work";
import { mockRoute } from "../mock/route";
import { mockScreen } from "../mock/screen";
import { screens } from "./registry";

test.beforeAll(() => loadCatalog("ko"));

for (const width of [1440, 390]) for (const theme of ["light", "dark"]) {
  test(`workplace sheet reads leave the chart in place at ${width}px in ${theme} @ui-state`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(value => localStorage.setItem("console.theme", value), theme);
    const fixture = await mockScreen(page, screens[2], "populated");
    await orgPanelReads(page);
    await orgWorkReads(page, "setup");
    await mockRoute(page, "get", "/api/v1/ref/lists/{key}/codes", request => ({ status: 200, json: {
      list: { key: new URL(request.url()).pathname.split("/").at(-2)!, status: "NOT_LOADED" as const }, items: [],
    } }));
    await mockRoute(page, "get", "/api/v1/access/me", { status: 200, json: { ...screenAccess("/org", "SETUP"), is_ops: true } });
    const held = Promise.withResolvers<void>();
    let failed = true;
    await page.route(`**/api/v1/legal-entities/${id(3)}`, async route => {
      await held.promise;
      if (failed) await route.fulfill({ status: 503, json: failure("service_unavailable") });
      else await route.fallback();
    });
    const chart = page.getByRole("region", { name: t("structure.chart.label"), exact: true, includeHidden: true });
    try {
      await page.goto(`/org?sel=${id(3)}&act=wp-create`);
      await expect(page.getByRole("tree", { includeHidden: true })).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      const before = await chart.boundingBox();
      const pendingSheet = page.getByRole("dialog", { name: t("workplace.add"), exact: true });
      await expect(pendingSheet.getByRole("status", { name: t("common.loading"), exact: true })).toBeVisible();
      await page.screenshot({ path: info.outputPath("loading.png") });
      held.resolve();
      await expect(page.getByRole("alert")).toContainText(t("common.loadFailed.title"), { timeout: 15_000 });
      expect(await chart.boundingBox()).toEqual(before);
      await expect(pendingSheet).toHaveCount(1);
      await expectAxe(page, "failed workplace sheet read");
      await page.screenshot({ path: info.outputPath("failed.png") });
      failed = false;
      await pendingSheet.getByRole("button", { name: t("common.retry"), exact: true }).click();
      const sheet = page.getByRole("dialog", { name: t("workplace.add"), exact: true });
      await expect(sheet.getByLabel(t("workplace.field.name"))).toBeVisible();
      await expect(page.getByRole("dialog")).toHaveCount(1);
      expect(await chart.boundingBox()).toEqual(before);
      await expectAxe(page, "ready workplace sheet");
      await fits(page, `workplace sheet ${width} ${theme}`);
      await page.screenshot({ path: info.outputPath("workplace-sheet.png") });
      await sheet.getByRole("button", { name: t("uiSheet.close"), exact: true }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      expect(await chart.boundingBox()).toEqual(before);
      expect(fixture.unexpected).toEqual([]);
    } finally { held.resolve(); await page.close(); fixture.release(); }
  });
}
