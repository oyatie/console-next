// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { fmtNumber } from "@console/i18n/format";
import type { Org } from "../../apps/web/src/features/platform/api";
import { VIEWS } from "../../apps/web/src/features/platform/domain/tenants";
import { expectAxe, fits } from "../a11y";
import { mockScreen } from "./screen";
import { mockRoute } from "./route";
import { AT, id, token } from "./fixtures";
import { screens } from "../states/registry";

test.beforeAll(() => loadCatalog("ko"));

for (const count of [0, 48]) for (const width of [1440, 390]) for (const theme of ["light", "dark"]) {
  test(`tenant list loading keeps its search and status controls with ${count} customers at ${width}px ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(theme => localStorage.setItem("console.theme", theme), theme);
    const fixture = await mockScreen(page, screens[0], "populated");
    const auth = token();
    const [header, payload, signature] = auth.access_token.split(".");
    auth.access_token = `${header}.${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload!, "base64url").toString()), platform: true })).toString("base64url")}.${signature}`;
    await mockRoute(page, "post", "/api/v1/auth/token/refresh", { status: 200, json: auth });
    const held = Promise.withResolvers<void>();
    const orgs: Org[] = Array.from({ length: count }, (_, index) => ({
      id: id(5000 + index), name: `검증 고객 ${index + 1}`, slug: `customer-${index + 1}`,
      group_id: null, group_slug: null, group_name: null, status: "ACTIVE", created_at: AT, updated_at: AT,
    }));
    await mockRoute(page, "get", "/api/platform/orgs", async () => {
      await held.promise;
      return { status: 200, json: orgs };
    });
    await mockRoute(page, "get", "/api/platform/ops", { status: 200, json: { tenants: [], notices: [] } });
    try {
      await page.goto("/platform");
      const main = page.getByRole("main");
      const search = main.getByRole("search");
      const views = main.getByRole("group", { name: t("tenants.views"), exact: true });
      const create = main.getByRole("button", { name: t("tenants.create"), exact: true });
      await expect(search).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      await expect.soft(create).toBeDisabled();
      await expect.soft(views.locator(".btn__count")).toHaveText(VIEWS.map(() => ""));
      const positions = async () => Promise.all([search.boundingBox(), views.getByRole("button").evaluateAll(elements => elements.map(el => el.getBoundingClientRect().toJSON()))]);
      const before = await positions();
      held.resolve();
      await expect(main.locator("#tenants-list")).toBeVisible();
      await expect(main.locator("#tenants-list tbody tr")).toHaveCount(orgs.length);
      expect(await search.count()).toBe(1);
      expect(await views.count()).toBe(1);
      expect.soft(await positions()).toEqual(before);
      await expect(create).toBeEnabled();
      await expect(create).toHaveCount(1);
      await expect(views.getByRole("button").first()).toContainText(t("tenants.view.active", { n: orgs.length }));
      await expect(views.getByRole("button").first()).toContainText(fmtNumber(orgs.length));
      await fits(page, `tenant-list/${width}/${theme}`);
      await expectAxe(page, `tenant-list/${width}/${theme}`);
      await page.screenshot({ path: test.info().outputPath("tenant-list.png"), fullPage: true });
      expect(fixture.unexpected).toEqual([]);
    } finally { held.resolve(); fixture.release(); await page.close(); }
  });
}
