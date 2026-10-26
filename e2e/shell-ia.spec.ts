// SPDX-License-Identifier: LicenseRef-Proprietary
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { go } from "./flows";
import { apiOf, bearerOf } from "./helpers/api";
import { openTenant } from "./helpers/tenant";

for (const theme of ["light", "dark"] as const) {
  for (const width of [1440, 390]) {
    test(`shell tenant facts on / and /account at ${width}px, ${theme}`, { tag: "@regression" }, async ({ browser }) => {
      const name = "셸 고객 이름";
      const page = await openTenant(browser, `shellfacts-${width}-${theme}`, name);
      await page.emulateMedia({ colorScheme: theme });
      await page.setViewportSize({ width, height: 900 });
      const api = apiOf(page, bearerOf(page));
      for (const route of ["/account", "/"]) {
        await go(page, route);
        await expect(page.getByRole("main").getByRole("heading", { level: 1 })).toBeVisible();
        await expect(page.getByRole("banner").getByRole("button", { name: "메뉴", exact: true })).toBeVisible({ visible: width === 390 });
        const response = await api("/users/me");
        expect(response.status()).toBe(200);
        expect((await response.json()).tenant).toEqual({ name, phase: "SETUP", go_live_at: null });
        const accessibility = await new AxeBuilder({ page }).include(".top").analyze();
        expect(accessibility.violations).toEqual([]);
      }
      await page.context().close();
    });
  }
}
