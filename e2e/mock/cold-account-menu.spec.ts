// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { experienceState } from "../experience";
import { screens } from "../states/registry";
import { mockScreen } from "./screen";

test.use({ storageState: experienceState("console") });
test.beforeAll(() => loadCatalog("ko"));

test("desktop account menu keeps focus as the cold screen resolves before the profile", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const fixture = await mockScreen(page, screens.find(screen => screen.path === "/people")!, "populated");
  const screenChunk = /\/assets\/people-route-[^/]+\.js$/;
  const screen = Promise.withResolvers<void>();
  const profile = Promise.withResolvers<void>();
  await page.route(screenChunk, async route => { await screen.promise; await route.continue(); });
  await page.route("**/api/v1/users/me", async route => { await profile.promise; await route.fallback(); });
  try {
    const chunkRequest = page.waitForRequest(request => screenChunk.test(new URL(request.url()).pathname));
    await page.goto("/people");
    await chunkRequest;
    const account = page.locator("#console-top-account");
    await account.click();
    const accountLink = page.getByRole("banner").getByRole("link", { name: t("shell.account"), exact: true });
    await expect(accountLink).toBeFocused();
    const profileRequest = page.waitForRequest("**/api/v1/users/me");
    screen.resolve();
    await profileRequest;
    await expect(accountLink).toBeFocused();
    profile.resolve();
    await expect(page.locator("[data-route-ready]")).toHaveAttribute("data-route-ready", "/people");
    await expect(accountLink).toBeFocused();
    await page.getByRole("button", { name: t("shell.theme.toDark"), exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(account).toBeFocused();
    expect(fixture.unexpected).toEqual([]);
  } finally {
    screen.resolve();
    profile.resolve();
    fixture.release();
    await page.unrouteAll({ behavior: "wait" });
  }
});
