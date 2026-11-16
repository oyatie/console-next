// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { mockNavigate } from "./navigation";
import { mockScreen } from "./screen";
import { screens } from "../states/registry";

test.beforeAll(() => loadCatalog("ko"));

test("mock navigation rejects an unexpected ready redirect", async ({ page }) => {
  const goto = page.goto.bind(page);
  // Bound only the expected readiness failure, after the document navigation has finished.
  page.goto = async (...args) => {
    const response = await goto(...args);
    page.setDefaultTimeout(1_000);
    return response;
  };
  await page.route("**/_gallery", route => route.fulfill({ contentType: "text/html", body:
    '<main>Redirected</main><span data-route-ready="/login" data-route-key="entry"></span><script>history.replaceState({ __TSR_key: "entry" }, "", "/login")</script>',
  }));
  await expect(mockNavigate(page, "/_gallery")).rejects.toThrow(/page.waitForFunction: Timeout/);
  await expect(page.locator("[data-route-ready]")).toHaveAttribute("data-route-ready", "/login");
});

test("mock navigation accepts a registered redirect destination", async ({ page }) => {
  await page.route("**/access", route => route.fulfill({ contentType: "text/html", body:
    '<main>Roles</main><span data-route-ready="/access/roles" data-route-key="entry"></span><script>history.replaceState({ __TSR_key: "entry" }, "", "/access/roles")</script>',
  }));
  await mockNavigate(page, "/access");
  await expect(page).toHaveURL(/\/access\/roles$/);
});

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
      // The configured assertion deadline must expire while navigation still waits for readiness.
      await expect(expect(page.locator("[data-page-gallery]")).toBeVisible()).rejects.toThrow();
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
