// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { expectAxe, fits } from "../a11y";
import { authz } from "../mock/fixtures";
import { mockRoute } from "../mock/route";
import { mockScreen } from "../mock/screen";
import { screens } from "./registry";

test.beforeAll(() => loadCatalog("ko"));

for (const width of [1440, 390]) for (const theme of ["light", "dark"]) for (const hr of [true, false]) {
  test(`request filters stay still while access loads: HR ${hr}, ${width}px ${theme} @ui-state`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(value => localStorage.setItem("console.theme", value), theme);
    const fixture = await mockScreen(page, screens[1], "empty");
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    await mockRoute(page, "get", "/api/v1/me/authz", async () => {
      await held;
      return { status: 200, json: { ...authz, capabilities: hr ? [...authz.capabilities, {
        feature: "employee_directory_manage", permission: "allow" as const, branch_scope: { kind: "all" as const }, org_wide: true, scoped: false,
      }] : authz.capabilities } };
    });
    await mockRoute(page, "get", "/api/v1/change-requests", { status: 200, json: { items: [], total: 0, offset: 0, limit: 20 } });
    try {
      await page.goto("/people/requests");
      const statuses = page.getByRole("group", { name: t("requests.statuses"), exact: true });
      const lanes = page.getByRole("group", { name: t("requests.lanes"), exact: true });
      await expect(statuses).toBeVisible();
      await expect(lanes).toHaveCount(0);
      await expect(page.getByRole("group", { name: t("requests.lanes"), exact: true, includeHidden: true })).toBeHidden();
      const before = await statuses.boundingBox();
      const loaded = page.waitForResponse(response => new URL(response.url()).pathname === "/api/v1/me/authz");
      release();
      await loaded;
      await expect(page.getByRole("button", { name: t("requests.lane.all"), exact: false })).toHaveCount(hr ? 1 : 0);
      await expect(page.getByRole("heading", { name: t("requests.none.title"), exact: true })).toBeVisible();
      // Compare control positions in both engines; Firefox has no layout-shift performance entries.
      expect(await statuses.boundingBox()).toEqual(before);
      await fits(page, "request filters after access loads");
      await expectAxe(page, "request filters after access loads");
      await page.screenshot({ path: info.outputPath("request-filters.png"), fullPage: true });
      expect(fixture.unexpected).toEqual([]);
    } finally { release(); await page.close(); fixture.release(); }
  });
}
