// SPDX-License-Identifier: LicenseRef-Proprietary
import { setTimeout as delay } from "node:timers/promises";
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { mockNavigate } from "./navigation";
import { mockScreen } from "./screen";
import { screens } from "../states/registry";

test.beforeAll(() => loadCatalog("ko"));

for (const [width, theme] of [[1440, "light"], [390, "dark"]] as const) {
  test(`mock navigation waits beyond the assertion deadline for the gallery chunk at ${width}px ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.addInitScript(value => localStorage.setItem("console.theme", value), theme);
    const fixture = await mockScreen(page, screens[1], "empty");
    const held = Promise.withResolvers<void>();
    const requested = Promise.withResolvers<void>();
    await page.route(/\/assets\/gallery-[^/]+\.js$/, async route => {
      requested.resolve();
      await held.promise;
      await route.continue();
    });
    let arrived = false;
    const navigation = mockNavigate(page, "/_gallery").then(() => { arrived = true; });
    try {
      await requested.promise;
      await expect(page.getByRole("status", { name: t("common.loading"), exact: true })).toBeVisible();
      await expect(page.locator("[data-route-ready]")).toHaveCount(0);
      // Hold the fault past Playwright's default 5 s assertion deadline; navigation waits on readiness.
      await delay(5_001);
      expect(arrived, "navigation must remain pending until the gallery commits").toBe(false);
      held.resolve();
      await navigation;
      expect(await page.locator("[data-route-ready]").getAttribute("data-route-ready")).toBe("/_gallery");
      expect(await page.locator("[data-page-gallery]").isVisible()).toBe(true);
      expect(await page.locator("html").getAttribute("data-theme")).toBe(theme);
      expect(fixture.unexpected).toEqual([]);
    } finally {
      held.resolve();
      await navigation;
      await page.unrouteAll({ behavior: "wait" });
      fixture.release();
    }
  });
}
