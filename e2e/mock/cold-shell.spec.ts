// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { fits } from "../a11y";
import { go } from "../flows";
import { screens } from "../states/registry";
import { mockScreen } from "./screen";

test.beforeAll(() => loadCatalog("ko"));

test("cold shell chunk has a loading fallback", async ({ page }) => {
  const fixture = await mockScreen(page, screens.find(screen => screen.path === "/people")!, "populated");
  const held = Promise.withResolvers<void>();
  const chunk = /\/assets\/shell-[^/]+\.js$/;
  await page.route(chunk, async route => { await held.promise; await route.continue(); });
  try {
    const requested = page.waitForRequest(request => chunk.test(new URL(request.url()).pathname));
    await page.goto("/people");
    await requested;
    await expect(page.getByRole("status", { name: t("common.loading"), exact: true })).toBeVisible({ timeout: 1500 });
    held.resolve();
    await expect(page.getByRole("navigation", { name: t("shell.nav"), exact: true })).toBeVisible();
    expect(fixture.unexpected).toEqual([]);
  } finally {
    held.resolve();
    fixture.release();
    await page.unrouteAll({ behavior: "wait" });
  }
});

for (const path of ["/org/nope", "/people/x/nope/deeper"]) for (const width of [1440, 390]) for (const theme of ["light", "dark"]) test(`${path}: unknown screen settles with usable navigation: ${width}px ${theme}`, async ({ page }) => {
  await page.setViewportSize({ width, height: 844 });
  await page.addInitScript(value => localStorage.setItem("console.theme", value), theme);
  const fixture = await mockScreen(page, screens.find(screen => screen.path === "/people")!, "populated");
  const identities: string[] = [];
  page.on("request", request => { if (new URL(request.url()).pathname === "/api/v1/users/me") identities.push(request.url()); });
  try {
    await page.goto(path);
    await expect(page.locator("[data-route-ready]")).toHaveAttribute("data-route-ready", path);
    if (width === 390) await page.getByRole("button", { name: t("shell.menu"), exact: true }).click();
    const rail = page.getByRole("navigation", { name: t("shell.nav"), exact: true });
    await expect(rail.getByRole("link").first()).toBeVisible();
    await expect(rail.locator('[aria-busy="true"]')).toHaveCount(0);
    expect(identities.length).toBeGreaterThan(0);
    if (width === 390) await page.keyboard.press("Escape");
    await fits(page, `unknown screen ${width}px ${theme}`);
    expect(fixture.unexpected).toEqual([]);
  } finally {
    fixture.release();
    await page.unrouteAll({ behavior: "wait" });
  }
});

for (const path of ["/people", "/inbox"]) for (const width of [1440, 390]) for (const theme of ["light", "dark"]) test(`${path}: cold shell remains available while the screen chunk is held: ${width}px ${theme}`, async ({ page }) => {
  await page.setViewportSize({ width, height: 844 });
  await page.addInitScript(value => localStorage.setItem("console.theme", value), theme);
  const screen = screens.find(screen => screen.path === (path === "/inbox" ? "/" : path))!;
  const fixture = await mockScreen(page, screen, "populated");
  const identities: string[] = [];
  page.on("request", request => { if (new URL(request.url()).pathname === "/api/v1/users/me") identities.push(request.url()); });
  const held = Promise.withResolvers<void>();
  const chunk = path === "/people" ? /\/assets\/people-route-[^/]+\.js$/ : /\/assets\/inbox-screen-[^/]+\.js$/;
  await page.route(chunk, async route => { await held.promise; await route.continue(); });
  try {
    const requested = page.waitForRequest(request => chunk.test(new URL(request.url()).pathname));
    await page.goto(path);
    await requested;
    if (width === 390) {
      await expect(page.getByRole("button", { name: t("shell.menu"), exact: true })).toBeVisible({ timeout: 1500 });
    } else await expect(page.getByRole("navigation", { name: t("shell.nav"), exact: true })).toBeVisible({ timeout: 1500 });
    expect(identities).toHaveLength(0);
    held.resolve();
    await expect(page.locator("[data-route-ready]")).toHaveAttribute("data-route-ready", path);
    expect(identities).toHaveLength(1);
    await go(page, path === "/inbox" ? "/people" : "/");
    expect(identities).toHaveLength(2);
    if (width === 390) {
      await page.getByRole("button", { name: t("shell.menu"), exact: true }).click();
      await expect(page.getByRole("navigation", { name: t("shell.nav"), exact: true })).toBeVisible();
      await page.keyboard.press("Escape");
    }
    await fits(page, `cold shell ${width}px ${theme}`);
    expect(fixture.unexpected).toEqual([]);
  } finally {
    held.resolve();
    fixture.release();
    await page.unrouteAll({ behavior: "wait" });
  }
});
