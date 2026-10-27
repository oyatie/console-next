// SPDX-License-Identifier: LicenseRef-Proprietary
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { go } from "./flows";
import { apiOf, bearerOf } from "./helpers/api";
import { openTenant } from "./helpers/tenant";
import { startOperations, tenantInSetup } from "./setup-flows";

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

test("solo setup keeps the checklist on Home and operating work opens in the inbox", async ({ browser }) => {
  const { admin } = await tenantInSetup(browser, "shellinbox", "업무함첫설정");
  await go(admin, "/inbox");
  const queue = admin.getByRole("region", { name: "업무함", exact: true });
  await expect(queue.getByRole("heading", { name: "설정은 홈에서 진행합니다", exact: true })).toBeVisible();
  await expect(queue.locator("[data-id]")).toHaveCount(0);
  await queue.getByRole("link", { name: "홈", exact: true }).click();
  await startOperations(admin);
  const rows = admin.getByRole("region", { name: "업무함", exact: true }).locator("[data-id]");
  await expect(rows.first()).toBeVisible();
  const first = await rows.first().getAttribute("data-id");
  await admin.getByRole("link", { name: "업무함에서 모두 보기", exact: true }).click();
  await expect(admin).toHaveURL(/\/inbox$/);
  await expect(queue.locator(`[data-id="${first}"]`)).toBeVisible();
});
