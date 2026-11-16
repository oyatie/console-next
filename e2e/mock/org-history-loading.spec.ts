// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { fits } from "../a11y";
import { routeReady } from "../flows";
import { orgChangeScreens } from "../states/registry";
import { mockScreen } from "./screen";
import { mockRoute } from "./route";

test.beforeAll(() => loadCatalog("ko"));

for (const path of ["/org/changes", "/org/history"]) for (const width of [1440, 390]) {
  test(`organization list avoids record forms on ${path} at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const fixture = await mockScreen(page, orgChangeScreens[0], "populated");
    await mockRoute(page, "get", "/api/v1/org-structure/batches", { status: 200, json: { items: [] } });
    await mockRoute(page, "get", "/api/v1/entity-setup/batches", { status: 200, json: { items: [] } });
    const recordChunks: string[] = [];
    page.on("request", request => {
      const path = new URL(request.url()).pathname;
      if (/\/assets\/(OrgChange|effectuate-consequence)-[^/]+\.js$/.test(path)) recordChunks.push(path);
    });
    try {
      await page.goto(path);
      await routeReady(page);
      const main = page.getByRole("main");
      if (path === "/org/history") await expect(main.getByText(t("orgHistory.foot", { count: 3 }), { exact: true })).toBeVisible();
      else await expect(main.getByRole("link", { name: "OC-2026-0001", exact: true })).toBeVisible();
      expect(recordChunks, "saved views must not download the change record and its command forms").toEqual([]);
      for (const theme of ["light", "dark"]) {
        await page.locator("html").evaluate((element, value) => { element.dataset.theme = value; }, theme);
        await fits(page, `${path}/${width}/${theme}`);
        await page.screenshot({ path: test.info().outputPath(`${theme}.png`), fullPage: true });
      }
      expect(fixture.unexpected).toEqual([]);
    } finally { await page.close(); fixture.release(); }
  });
}
