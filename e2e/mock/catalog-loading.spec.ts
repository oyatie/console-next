// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { fits } from "../a11y";
import { routeReady } from "../flows";
import { barControl } from "../shell";
import { screens } from "../states/registry";
import { mockScreen } from "./screen";
import { mockRoute } from "./route";
import { AT, authz, failure, token, user } from "./fixtures";

test.beforeAll(() => loadCatalog("ko"));

for (const path of ["/login", "/setup-passkey", "/people"]) for (const width of [1440, 390]) for (const theme of ["light", "dark"]) {
  test(`${path} honors its catalog loading boundary: ${width}px ${theme}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(value => localStorage.setItem("console.theme", value), theme);
    const fixture = await mockScreen(page, screens[1], "populated");
    await mockRoute(page, "post", "/api/v1/auth/passkey/login/start", { status: 403, json: failure("forbidden") });
    if (path === "/setup-passkey") {
      const claims = { sub: user.id, org: authz.org_id, enrollment: true, exp: Math.floor(Date.now() / 1000) + 3600 };
      await mockRoute(page, "post", "/api/v1/auth/token/refresh", { status: 200, json: {
        ...token(), access_token: `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`, requires_passkey_setup: true, privacy_consent_accepted: false,
      } });
      const terms = { version: "test", sha256: "a".repeat(64) };
      await mockRoute(page, "get", "/api/v1/onboarding/terms", { status: 200, json: {
        ...terms, body: "Terms", privacy: { ...terms, title: "Privacy", body: "Privacy terms", published_on: AT.slice(0, 10), policy_url: "/privacy", review_pending: false },
      } });
    }
    const held = Promise.withResolvers<void>();
    const catalog = path === "/people" ? /\/assets\/boot-ko-[^/]+\.js$/ : /\/assets\/ko-[^/]+\.js$/;
    await page.route(catalog, async route => { await held.promise; await route.continue(); });
    try {
      const requested = page.waitForRequest(request => catalog.test(new URL(request.url()).pathname));
      // Enrollment paints from boot copy alone: wait for its chunk and the boot catalog, never the held screen catalog.
      const painted = path === "/setup-passkey" ? [/\/assets\/SetupPasskey-[^/]+\.js$/, /\/assets\/boot-ko-[^/]+\.js$/].map(chunk => page.waitForResponse(response => chunk.test(new URL(response.url()).pathname))) : [];
      await page.goto(path);
      await requested;
      if (path === "/login") {
        await expect(page.getByRole("heading", { name: t("auth.login.title"), exact: true })).toBeVisible();
        await expect(page.getByRole("button", { name: t("auth.login.passkey"), exact: true })).toBeVisible();
      } else if (path === "/setup-passkey") {
        await Promise.all(painted);
        await expect(page.getByRole("checkbox")).toHaveCount(2);
        await expect(page.locator("[data-marker]")).toHaveText(t("uiField.required"));
        await expect(page.locator("body")).not.toContainText("uiField.");
      } else {
        await expect(page.getByRole("status", { name: t("common.loading"), exact: true }).first()).toBeVisible();
        await expect(page.getByRole("navigation", { name: t("shell.nav"), exact: true })).toHaveCount(0);
      }
      await page.screenshot({ path: testInfo.outputPath("catalog-held.png") });
      held.resolve();
      await routeReady(page, path);
      if (path === "/login") await expect(page.getByRole("heading", { name: t("auth.login.title"), exact: true })).toBeVisible();
      else if (path === "/setup-passkey") {
        await expect(page.getByRole("checkbox")).toHaveCount(2);
        await expect(page.locator("[data-marker]")).toHaveText(t("uiField.required"));
        await expect(page.locator("body")).not.toContainText("uiField.");
      } else {
        // The theme control in the catalog's words: Classic's toggle in the bar, Console's pair in the account menu.
        await expect(await barControl(page, bar => bar.getByRole("button", { name: t(theme === "dark" ? "shell.theme.toLight" : "shell.theme.toDark"), exact: true })
          .or(bar.getByRole("button", { name: t(theme === "dark" ? "shell.theme.dark" : "shell.theme.light"), exact: true })))).toBeVisible();
        await page.keyboard.press("Escape");
      }
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      if (path !== "/people") expect(await page.evaluate(() => document.scrollingElement!.scrollWidth <= innerWidth)).toBe(true);
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

test("a failed screen catalog leaves sign-in usable", async ({ page }) => {
  const fixture = await mockScreen(page, screens[1], "populated");
  await mockRoute(page, "post", "/api/v1/auth/passkey/login/start", { status: 403, json: failure("forbidden") });
  let failures = 0;
  await page.route(/\/assets\/ko-[^/]+\.js$/, route => { failures++; return route.abort("failed"); });
  try {
    await page.goto("/login");
    await expect.poll(() => failures).toBeGreaterThanOrEqual(2);
    await expect(page.getByRole("heading", { name: t("auth.login.title"), exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: t("auth.login.passkey"), exact: true })).toBeVisible();
    await expect(page.locator("#root")).toBeVisible();
    await expect(page.locator("#chunk-fallback")).toHaveCount(0);
    expect(fixture.unexpected).toEqual([]);
  } finally { fixture.release(); }
});
