// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { expectAxe, fits } from "../a11y";
import { mockScreen } from "./screen";
import { mockRoute } from "./route";
import { screenAccess } from "./fixtures";
import { screens } from "../states/registry";

test.beforeAll(() => loadCatalog("ko"));
const rows = [
  ["/settings/company-domain", "shell.settings.domain", "account.domain.title"],
  ["/people/numbering", "identifiers.numbering.title", "identifiers.numbering.title"],
  ["/people/job-titles", "shell.settings.titles", "titles.title"],
  ["/people/period-locks", "periodLocks.title", "periodLocks.title"],
] as const;

for (const width of [1440, 390]) for (const profile of ["admin", "branch", "none"] as const) {
  test(`settings hub ${profile} at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const fixture = await mockScreen(page, screens[0], "empty");
    const access = screenAccess(profile === "branch" ? "/people/job-titles" : "/");
    access.is_ops = profile === "admin";
    if (profile === "branch") for (const entry of access.entries) entry.scope.kind = "WORKPLACE";
    await mockRoute(page, "get", "/api/v1/access/me", { status: 200, json: access });
    try {
      await page.goto("/settings");
      const main = page.getByRole("main");
      if (profile === "none") {
        await expect(main.getByRole("region", { name: t("common.denied.title.plain"), exact: true })).toHaveCount(1);
        await expect(main.getByRole("heading", { name: t("shell.link.settings"), exact: true })).toHaveCount(0);
        await expect(page.getByRole("navigation", { name: t("shell.nav"), exact: true }).getByRole("link", { name: t("shell.link.settings"), exact: true })).toHaveCount(0);
      } else {
        await expect(main.getByRole("heading", { level: 1, name: t("shell.link.settings"), exact: true })).toBeVisible();
        for (const [path, label] of rows) {
          const link = main.getByRole("link", { name: t(label), exact: true });
          if (profile === "admin" || path === "/people/job-titles") await expect(link).toHaveAttribute("href", path);
          else await expect(link).toHaveCount(0);
        }
        await expect(main.getByRole("link")).toHaveCount(profile === "admin" ? 4 : 1);
      }
      await fits(page, `settings/${profile}/${width}`);
      await expectAxe(page, `settings/${profile}/${width}`);
      expect(fixture.unexpected).toEqual([]);
      if (profile === "admin") for (const theme of ["light", "dark"]) {
        await page.locator("html").evaluate((el, value) => { el.dataset.theme = value; }, theme);
        await page.screenshot({ path: test.info().outputPath(`settings-${width}-${theme}.png`) });
      }
      if (profile === "admin") for (const [path, label, title] of rows) {
        await page.goto("/settings");
        await main.getByRole("link", { name: t(label), exact: true }).click();
        await expect(page).toHaveURL(new RegExp(`${path}$`));
        await expect(main.getByRole("heading", { level: 1, name: t(title), exact: true }).first()).toBeVisible();
      }
    } finally { await page.close(); fixture.release(); }
  });
}

for (const width of [1440, 390]) test(`settings hub gallery at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  await page.goto("/_gallery");
  if (width === 390) {
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
  }
  const demo = page.locator("[data-settings-gallery]");
  await expect(demo.getByRole("heading", { name: t("shell.link.settings"), exact: true })).toBeVisible();
  await expect(demo.getByRole("link")).toHaveCount(4);
  await expectAxe(page, `settings gallery/${width}`, { include: "[data-settings-gallery]" });
});
