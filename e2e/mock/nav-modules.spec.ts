// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import type { components } from "@console/api";
import { loadCatalog, t } from "@console/i18n";
import { mockScreen } from "./screen";
import { mockRoute } from "./route";
import { failure } from "./fixtures";
import { screens } from "../states/registry";

test.beforeAll(() => loadCatalog("ko"));

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
    const rail = page.getByRole("navigation", { name: t("shell.nav"), exact: true });
    const people = rail.getByRole("link", { name: t("shell.link.people"), exact: true });
    if (readiness === "not-ready") await expect(people).toHaveCount(0);
    else await expect(people).toBeVisible();
    await expect(rail.getByRole("status")).toHaveCount(0);
    await expect(page.getByRole("main").getByRole("grid", { name: "직원", exact: true })).toBeVisible();
    expect(fixture.unexpected).toEqual([]);
  });
}

test("shared shell support: refused read still answers the rail", async ({ page }) => {
  const fixture = await mockScreen(page, screens[1], "populated");
  await mockRoute(page, "get", "/api/v1/support-sessions/active", { status: 403, json: failure("forbidden") });
  await page.goto("/people");
  const rail = page.getByRole("navigation", { name: t("shell.nav"), exact: true });
  await expect(rail.getByRole("link", { name: t("shell.link.people"), exact: true })).toBeVisible();
  await expect(rail.getByRole("link", { name: t("shell.link.audit"), exact: true })).toHaveCount(0);
  await expect(rail.getByRole("status")).toHaveCount(0);
  expect(fixture.unexpected).toEqual([]);
});
