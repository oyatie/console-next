// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { fits } from "../a11y";
import { routeReady } from "../flows";
import { screens } from "../states/registry";
import { mockScreen } from "./screen";
import { mockRoute } from "./route";
import { failure } from "./fixtures";

test.beforeAll(() => loadCatalog("ko"));

for (const path of ["/login", "/people"]) for (const width of [1440, 390]) for (const theme of ["light", "dark"]) {
  test(`${path} waits for translated copy before painting: ${width}px ${theme}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(value => localStorage.setItem("console.theme", value), theme);
    const fixture = await mockScreen(page, screens[1], "populated");
    await mockRoute(page, "post", "/api/v1/auth/passkey/login/start", { status: 403, json: failure("forbidden") });
    const held = Promise.withResolvers<void>();
    const catalog = /\/assets\/boot-ko-[^/]+\.js$/;
    await page.route(catalog, async route => { await held.promise; await route.continue(); });
    try {
      const requested = page.waitForRequest(request => catalog.test(new URL(request.url()).pathname));
      await page.goto(path);
      await requested;
      await expect(page.getByRole("status", { name: t("common.loading"), exact: true }).first()).toBeVisible();
      await expect(page.getByRole("heading", { name: t("auth.login.title"), exact: true })).toHaveCount(0);
      await expect(page.getByRole("navigation", { name: t("shell.nav"), exact: true })).toHaveCount(0);
      held.resolve();
      await routeReady(page, path);
      if (path === "/login") await expect(page.getByRole("heading", { name: t("auth.login.title"), exact: true })).toBeVisible();
      else await expect(page.getByRole("button", { name: t("shell.theme.toDark"), exact: true }).or(page.getByRole("button", { name: t("shell.theme.toLight"), exact: true }))).toBeVisible();
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      if (path === "/login") expect(await page.evaluate(() => document.scrollingElement!.scrollWidth <= innerWidth)).toBe(true);
      else await fits(page, `${path} ${width}px ${theme}`);
      const screenshot = testInfo.outputPath("first-screen.png");
      await page.screenshot({ path: screenshot });
      await testInfo.attach("first-screen", { path: screenshot, contentType: "image/png" });
      expect(fixture.unexpected).toEqual([]);
    } finally {
      held.resolve();
      fixture.release();
      await page.unrouteAll({ behavior: "wait" });
    }
  });
}
