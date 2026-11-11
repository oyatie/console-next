// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { fits } from "../a11y";
import { routeReady } from "../flows";
import { openUnit } from "../helpers/structure";
import { orgPanelReads } from "./org-work";
import { mockRoute } from "./route";
import { mockScreen } from "./screen";
import { screens } from "../states/registry";

for (const path of ["/org/entities", "/org/changes", "/org?view=list", "/org?view=outline", "/org"]) {
  for (const width of [1440, 390]) for (const theme of ["light", "dark"] as const) {
    test(`structure helper opens a unit from ${path} at ${width}px in ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: theme });
      const fixture = await mockScreen(page, screens[2], "populated");
      const { dept } = await orgPanelReads(page);
      await mockRoute(page, "get", "/api/v1/entity-identifier-corrections", { status: 200, json: { items: [], next_offset: null } });
      try {
        await page.goto(path);
        await routeReady(page);
        await expect(page).toHaveURL(/\/org(?:\?|$)/);
        const panel = await openUnit(page, dept.name);
        await expect(panel).toBeVisible();
        await expect(page.getByRole("searchbox", { name: "조직 찾기" })).toBeVisible();
        const selected = page.url();
        await openUnit(page, dept.name);
        expect(page.url()).toBe(selected);
        await expect(panel).toBeVisible();
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        await fits(page, `structure panel/${width}/${theme}`);
        await page.screenshot({ path: test.info().outputPath("panel.png") });
        expect(fixture.unexpected).toEqual([]);
      } finally { await page.close(); fixture.release(); }
    });
  }
}
