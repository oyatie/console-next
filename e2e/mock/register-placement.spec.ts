// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { fits } from "../a11y";
import { AT, id, user } from "./fixtures";
import { mockLifecycleSheets } from "./lifecycle-sheets";
import { mockRoute } from "./route";
import { mockScreen } from "./screen";
import { lifecycleSheetScreens } from "../states/lifecycle-sheets";
import { screens } from "../states/registry";

test.beforeAll(() => loadCatalog("ko"));

for (const width of [1280, 390]) for (const theme of ["light", "dark"]) {
  test(`placement chips keep their geometry as unit options arrive at ${width}px in ${theme}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(value => localStorage.setItem("console.theme", value), theme);
    const fixture = await mockScreen(page, screens[1], "populated");
    await mockLifecycleSheets(page, lifecycleSheetScreens[0]);
    await mockRoute(page, "get", "/api/v1/access/me", { status: 200, json: { account_id: user.id, is_ops: true, phase: "OPERATING", as_of: AT, entries: [] } });
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    await page.route("**/api/v1/org-units", async route => { await held; await route.fallback(); });
    try {
      await page.goto(`/people/new?unit=${id(4003)}`);
      const sheet = page.getByRole("dialog", { name: t("register.title"), exact: true });
      const chips = sheet.getByRole("radiogroup", { name: t("register.where") }).locator("label").filter({ has: page.getByRole("radio") });
      await expect(chips).toHaveCount(3);
      await page.evaluate(() => document.fonts.ready);
      const geometry = () => chips.evaluateAll(elements => elements.map(element => {
        const { x, y, width, height } = element.getBoundingClientRect();
        return { x, y, width, height };
      }));
      const before = await geometry();
      const department = sheet.getByRole("radio", { name: t("register.where.unit"), exact: true });
      await expect(department).not.toBeChecked();
      release();
      await expect(department).toBeChecked();
      expect(await geometry()).toEqual(before);
      await fits(page, `registration placement ${width} ${theme}`);
      await page.screenshot({ path: info.outputPath("registration.png"), fullPage: true });
      expect(fixture.unexpected).toEqual([]);
    } finally { release(); await page.close(); fixture.release(); }
  });
}
