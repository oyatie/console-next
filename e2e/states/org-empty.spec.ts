// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { expectAxe, fits } from "../a11y";
import { id } from "../mock/fixtures";
import { orgChange } from "../mock/org-changes";
import { orgWorkReads } from "../mock/org-work";
import { mockRoute } from "../mock/route";
import { mockScreen } from "../mock/screen";
import { orgChangeScreens, screens } from "./registry";

test.beforeAll(() => loadCatalog("ko"));

const routes = ["/org", "/org/changes", `/org/changes/${id(3000)}`, "/org/move", "/org/paste", "/org/import", "/org/history"];
for (const path of routes) for (const width of [1440, 390]) {
  test(`org empty: ${path} at ${width}px @ui-state`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width, height: 900 });
    const record = path.startsWith("/org/changes/");
    const list = path === "/org/changes" || path === "/org/history";
    const fixture = await mockScreen(page, record ? orgChangeScreens[1] : list ? orgChangeScreens[0] : screens[2], "empty");
    await orgWorkReads(page, "empty");
    if (path === "/org/history") {
      await mockRoute(page, "get", "/api/v1/org-structure/batches", { status: 200, json: { items: [] } });
      await mockRoute(page, "get", "/api/v1/entity-setup/batches", { status: 200, json: { items: [] } });
    }
    if (record) await mockRoute(page, "get", "/api/v1/org-changes/{id}", { status: 200, json: { ...orgChange("draft"), events: [] } });
    try {
      await page.goto(path);
      const main = page.getByRole("main");
      if (record) {
        const history = main.getByRole("complementary", { name: t("orgChange.history"), exact: true });
        await expect(history.getByText(t("orgChange.history.empty"), { exact: true })).toBeVisible({ timeout: 20_000 });
        await expect(history.getByRole("listitem")).toHaveCount(0);
        await history.scrollIntoViewIfNeeded();
      } else if (path === "/org/history") {
        await expect(page).toHaveURL(/\/org\?.*filter=history/);
        await expect(main.getByRole("status").filter({ hasText: t("orgHistory.empty") })).toBeVisible({ timeout: 20_000 });
      } else if (list) {
        await expect(main.getByRole("heading", { name: t("orgChange.list.empty.open"), exact: true })).toBeVisible({ timeout: 20_000 });
        await expect(main.getByRole("link", { name: t("orgChange.list.empty.action"), exact: true })).toHaveAttribute("href", "/org");
      } else if (path === "/org/import") {
        await expect(main.getByRole("button", { name: t("uiFileDrop.pick"), exact: true })).toBeVisible({ timeout: 20_000 });
        await expect(main.getByRole("button", { name: t("orgBulk.import.apply", { count: 0 }), exact: true })).toHaveCount(0);
      } else if (path === "/org/move") {
        await expect(main.getByText(t("bulkMove.nothing"), { exact: true })).toBeVisible({ timeout: 20_000 });
        await expect(main.getByRole("link", { name: t("orgChange.list.empty.action"), exact: true })).toHaveAttribute("href", "/org");
      } else {
        await expect(main.getByRole("link", { name: t("entity.empty.action"), exact: true })).toHaveAttribute("href", "/org/entities/new", { timeout: 20_000 });
      }
      await expect(main.getByRole("alert")).toHaveCount(0);
      await expect(main.locator("[data-read-layout]")).toHaveCount(0);
      for (const theme of ["light", "dark"]) {
        await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
        await fits(page, `empty ${path}/${width}/${theme}`);
        await page.screenshot({ path: test.info().outputPath(`empty-${theme}.png`), fullPage: true });
      }
      await expectAxe(page, `empty ${path}/${width}`);
      expect(fixture.unexpected).toEqual([]);
    } finally { await page.close(); fixture.release(); }
  });
}
