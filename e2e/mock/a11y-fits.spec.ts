// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { fits } from "../a11y";
import { experienceState } from "../experience";
import { accountSecurityScreens } from "../states/account-security";
import { screens } from "../states/registry";
import { accountSecurityReads } from "./account-security";
import { failure, id } from "./fixtures";
import { mockRoute } from "./route";
import { mockScreen } from "./screen";

test.beforeAll(() => loadCatalog("ko"));
test.use({ viewport: { width: 390, height: 844 } });

for (const theme of ["light", "dark"]) {
  for (const fixture of [
    { name: "ignores an overflowing unrelated class", overflow: false, body:
      '<div class="main" style="overflow:auto"><div style="width:200%">Decoration</div></div><main>Content</main>' },
    { name: "checks an explicit main role", overflow: true, body:
      '<div class="main">Decoration</div><div role="main" style="overflow:auto"><div style="width:200%">Content</div></div>' },
    { name: "checks the outer landmark before a nested main", overflow: true, body:
      '<main style="overflow:auto"><div style="width:200%">Content</div><main class="main">Request</main></main>' },
  ]) {
    test(`fits ${fixture.name} in ${theme}`, async ({ page }) => {
      await page.setContent(`<!doctype html><html lang="ko" data-theme="${theme}"><head><title>Width check</title>
        <style>body { margin: 0; } html { color-scheme: ${theme}; }</style></head>
        <body><main hidden>Hidden</main>${fixture.body}</body></html>`);
      expect(await page.evaluate(() => document.scrollingElement!.scrollWidth - innerWidth)).toBe(0);
      if (fixture.overflow) await expect(fits(page, fixture.name)).rejects.toThrow(/scrolls sideways/);
      else await fits(page, fixture.name);
    });
  }

  for (const screen of accountSecurityScreens) {
    test(`fits the standalone ${screen.key} landmark in ${theme}`, async ({ page }) => {
      const fixture = await accountSecurityReads(page, screen, "failed");
      try {
        await page.goto(screen.path);
        const main = page.getByRole("main");
        await expect(main).toHaveCount(1);
        await expect(main.getByRole("heading", { name: t(screen.key === "login" ? "auth.login.title" : "auth.setup.consent.title"), exact: true })).toBeVisible();
        await page.locator("html").evaluate((el, value) => { el.dataset.theme = value; }, theme);
        await page.evaluate(() => document.fonts.ready);
        await fits(page, screen.path);
        expect(fixture.unexpected).toEqual([]);
      } finally { await page.close(); fixture.release(); }
    });
  }

  for (const path of ["/requests", `/requests/${id(99)}`]) {
    test(`fits the shell around the nested ${path} landmark in ${theme}`, async ({ page }) => {
      const fixture = await mockScreen(page, screens[0], "empty");
      await mockRoute(page, "get", "/api/v1/me/requests", { status: 200, json: { items: [], total: 0, offset: 0, limit: 50 } });
      await mockRoute(page, "get", "/api/v1/requests/{key}", { status: 404, json: failure("request_not_found") });
      try {
        await page.goto(path);
        const main = page.getByRole("main", { name: t("shell.main"), exact: true });
        await expect(main.getByRole("heading", { name: t("requestOutcome.title"), exact: true })).toBeVisible();
        // A restyle can rename the shell's class and id while preserving its landmark.
        await main.evaluate(el => {
          el.classList.remove("main");
          el.removeAttribute("id");
        });
        await page.locator("html").evaluate((el, value) => { el.dataset.theme = value; }, theme);
        await page.evaluate(() => document.fonts.ready);
        await fits(page, path);
        expect(fixture.unexpected).toEqual([]);
      } finally { await page.close(); fixture.release(); }
    });
  }
}

// How each style marks the landmarks above. No board draws sign-in or the request pages, so Console's values are the
// render's: the sign-in pattern on main, and the shell's main as the only one (Classic nests the page's own).
for (const style of ["baseline", "console"] as const) test.describe(`${style} landmarks`, () => {
  test.use({ storageState: experienceState(style) });
  const pin = style === "baseline" ? { tag: "@baseline" } : {};
  for (const screen of accountSecurityScreens) test(`the standalone ${screen.key} main is ${style}'s sign-in`, pin, async ({ page }) => {
    const fixture = await accountSecurityReads(page, screen, "failed");
    try {
      await page.goto(screen.path);
      const main = page.getByRole("main");
      await expect(main.getByRole("heading", { name: t(screen.key === "login" ? "auth.login.title" : "auth.setup.consent.title"), exact: true })).toBeVisible();
      if (style === "baseline") await expect(main).toHaveClass("auth");
      else await expect(main).toHaveAttribute("data-pattern", "sign-in");
    } finally { await page.close(); fixture.release(); }
  });

  for (const path of ["/requests", `/requests/${id(99)}`]) test(`the shell around ${path} has ${style}'s main landmarks`, pin, async ({ page }) => {
    const fixture = await mockScreen(page, screens[0], "empty");
    await mockRoute(page, "get", "/api/v1/me/requests", { status: 200, json: { items: [], total: 0, offset: 0, limit: 50 } });
    await mockRoute(page, "get", "/api/v1/requests/{key}", { status: 404, json: failure("request_not_found") });
    try {
      await page.goto(path);
      const main = page.getByRole("main", { name: t("shell.main"), exact: true });
      await expect(main.getByRole("heading", { name: t("requestOutcome.title"), exact: true })).toBeVisible();
      await expect(page.getByRole("main")).toHaveCount(style === "baseline" ? 2 : 1);
      if (style === "baseline") await expect(main).toHaveClass(/\bmain\b/);
    } finally { await page.close(); fixture.release(); }
  });
});
