// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { expectAxe, fits } from "../a11y";
import { accessScreens, mockAccessScreen } from "../states/access";
import { AT, user } from "./fixtures";
import { mockRoute } from "./route";

test.beforeAll(() => loadCatalog("ko"));

for (const state of ["enabled", "disabled", "missing", "failed"] as const) {
  for (const width of [1440, 390]) test(`payroll module ${state} drives the role editor and rail at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const fixture = await mockAccessScreen(page, accessScreens[1], "empty");
    const levels: ("view" | "edit" | "export")[] = ["view", "edit", "export"];
    await mockRoute(page, "get", "/api/v1/access/me", { status: 200, json: {
      account_id: user.id, is_ops: true, phase: "OPERATING", as_of: AT, entries: [],
    } });
    await mockRoute(page, "get", "/api/v1/access/catalog", { status: 200, json: {
      domains: ["pay", "sensitive"].map(domain => ({ domain, grantable: true, levels,
        operations: levels.map(level => ({ operation: `${domain}::${level}`, level })) })),
      levels, scope_kinds: [], reason_domain: "role_change",
    } });
    await page.route("**/api/v1/onboarding/modules", route => route.fulfill(state === "failed"
      ? { status: 503, json: { error: { code: "unavailable" } } }
      : { json: state === "missing" ? [] : [{ key: "payroll", ready: state === "enabled", unblock: null }] }));
    await page.goto("/access/roles/new");
    await expect(page.getByRole("checkbox", { name: "민감 급여 그룹 조회", exact: true })).toBeVisible();
    const inactive = page.getByText(t("payroll.accessInactive"), { exact: true });
    await expect(inactive).toHaveCount(state === "enabled" ? 0 : 1);
    if (state !== "enabled") {
      expect(await inactive.evaluate(el => el.closest("td"))).toBeNull();
      expect(await inactive.evaluate(el => el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight))).toBeLessThanOrEqual(5);
    }
    if (width === 1440) {
      const rail = page.getByRole("navigation", { name: t("shell.nav"), exact: true });
      await expect(rail.getByRole("link", { name: t("shell.link.payroll"), exact: true })).toHaveCount(state === "enabled" ? 1 : 0);
    }
    for (const theme of ["light", "dark"]) {
      await page.locator("html").evaluate((el, theme) => { el.dataset.theme = theme; }, theme);
      await fits(page, `payroll module/${state}/${width}/${theme}`);
      await expectAxe(page, `payroll module/${state}/${width}/${theme}`);
    }
    expect(fixture.unexpected).toEqual([]);
  });
}
