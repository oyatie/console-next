// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { screens } from "../states/registry";
import { mockScreen } from "./screen";
import { mockRoute } from "./route";
import { modules } from "./fixtures";
import { accountReads } from "./account";

test.beforeAll(() => loadCatalog("ko"));

for (const [route, owner, label, sibling] of [
  ["/account/location", "/account", "account.location.link", "account.privacy.title"],
  ["/me/dispatch-offers", "/me/desk", "me.dispatch.link", "me.desk.links.attendance"],
] as const) {
  test(`personal task ${route} is displayed only when its API is mounted`, async ({ page }) => {
    const fixture = await mockScreen(page, screens[0], "populated");
    if (owner === "/account") await accountReads(page, "save-unchanged");
    let compiled = true;
    await mockRoute(page, "get", "/api/v1/onboarding/modules", () => ({ status: 200, json: modules.ready.filter(row => compiled || !["personal_location", "dispatch_offers"].includes(row.key)) }));
    try {
      await page.goto(owner);
      await expect(page.getByRole("link", { name: t(label), exact: true })).toBeVisible();
      compiled = false;
      await page.reload();
      await expect(page.getByRole("link", { name: t(sibling), exact: true }).first()).toBeVisible();
      await expect(page.getByRole("link", { name: t(label), exact: true })).toHaveCount(0);
      const serviceReads: string[] = [];
      page.on("request", request => {
        const path = new URL(request.url()).pathname;
        if (path === "/api/v1/location-consent/status" || path === "/api/v1/me/dispatch-offers") serviceReads.push(path);
      });
      await page.goto(route);
      await expect(page.getByText(t("common.denied.title.plain"), { exact: true })).toBeVisible();
      expect(serviceReads).toEqual([]);
    } finally { await page.close(); fixture.release(); }
  });
}
