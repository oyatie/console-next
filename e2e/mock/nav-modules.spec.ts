// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import type { components } from "@console/api";
import { mockScreen } from "./screen";
import { screens } from "../states/registry";

for (const readiness of ["ready", "not-ready", "refused"] as const) {
  test(`shared shell modules: ${readiness}`, async ({ page }) => {
    const fixture = await mockScreen(page, screens[1], "populated", readiness);
    const modules = page.waitForResponse("**/api/v1/onboarding/modules");
    await page.goto("/people");
    const response = await modules;
    expect(response.status()).toBe(readiness === "refused" ? 403 : 200);
    if (readiness === "refused") {
      expect(await response.json()).toMatchObject({ error: { code: "forbidden" } });
    } else {
      const body: components["schemas"]["OnboardingModules"] = await response.json();
      expect(body.filter(module => module.ready).map(module => module.key)).toEqual(readiness === "ready"
        ? ["home", "org", "access", "people", "exits", "attendance", "statutory"] : ["home", "org", "access"]);
      expect(body.find(module => module.key === "people")?.unblock).toBe(readiness === "ready" ? null : "create_legal_entity");
      expect(body.every(module => Object.keys(module).sort().join() === "key,ready,unblock")).toBe(true);
    }
    const people = page.getByRole("navigation", { name: "주 메뉴", exact: true }).getByRole("link", { name: "직원", exact: true });
    if (readiness === "not-ready") await expect(people).toHaveCount(0);
    else await expect(people).toBeVisible();
    await expect(page.getByRole("main").getByRole("grid", { name: "직원", exact: true })).toBeVisible();
    expect(fixture.unexpected).toEqual([]);
  });
}
