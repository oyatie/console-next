// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { expectAxe, fits } from "../a11y";
import { screenAccess } from "../mock/fixtures";
import { mockRoute } from "../mock/route";
import { mockScreen } from "../mock/screen";
import { screens } from "./registry";

test.beforeAll(() => loadCatalog("ko"));

const surfaces = [
  { path: "/people/bulk", title: "bulk.page.empty.title" },
  { path: "/people/renew", title: "renew.empty.title" },
  { path: "/people?tab=appointments", title: "bulk.page.empty.title" },
] as const;

for (const surface of surfaces) for (const width of [1440, 390]) for (const theme of ["light", "dark"]) {
  test(`hr_basic editor opens ${surface.path} at ${width}px in ${theme} @ui-state`, async ({ page }, info) => {
    const state = await mockScreen(page, screens[1], "populated");
    const access = screenAccess("/people/new");
    let decision = true;
    expect(access.entries.some(entry => entry.domain === "hr_basic" && entry.level === "edit")).toBe(true);
    expect(access.entries.some(entry => entry.domain === "appointment")).toBe(false);
    await mockRoute(page, "get", "/api/v1/access/me", () => ({ status: 200, json: { ...access, decisions: { bulk_appointment: decision } } }));
    await mockRoute(page, "get", "/api/v1/job-titles", { status: 200, json: { items: [], can_manage: false } });
    await mockRoute(page, "get", "/api/v1/reason-codes", request => ({ status: 200, json: { domain: new URL(request.url()).searchParams.get("domain")!, items: [] } }));
    await mockRoute(page, "get", "/api/v1/appointment-notices", { status: 200, json: { items: [], next_cursor: null } });
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(value => localStorage.setItem("console.theme", value), theme);
    try {
      await page.goto(surface.path);
      const main = page.getByRole("main");
      if (surface.path.includes("tab=")) await expect(main.getByRole("navigation", { name: t("roster.head.title"), exact: true }).getByRole("link", { name: t("roster.page.appointments"), exact: true })).toHaveAttribute("aria-current", "page");
      await expect(main.getByRole("heading", { name: t(surface.title), exact: true })).toBeVisible();
      await expect(main.getByRole("region", { name: t("common.denied.title.plain"), exact: true })).toHaveCount(0);
      await fits(page, `${surface.path} ${width} ${theme}`);
      await expectAxe(page, surface.path);
      await page.screenshot({ path: info.outputPath("access-allowed.png"), fullPage: true });
      decision = false;
      await page.reload();
      const refusal = page.getByRole("main").getByRole("region", { name: t("common.denied.title.plain"), exact: true });
      for (const id of ["accessCodes.domain.hr_basic", "accessCodes.domain.appointment", "accessCodes.level.edit", "access.scope.tenant"] as const) {
        await expect(refusal).toContainText(t(id));
      }
      await fits(page, `${surface.path} refused ${width} ${theme}`);
      await expectAxe(page, `${surface.path} refused`);
      await page.screenshot({ path: info.outputPath("access-refused.png"), fullPage: true });
      expect(state.unexpected).toEqual([]);
    } finally { await page.close(); state.release(); }
  });
}

for (const surface of surfaces) for (const decision of [false, undefined]) {
  test(`${surface.path} stays closed for a ${decision === false ? "refused" : "missing"} server decision @ui-state`, async ({ page }) => {
    const state = await mockScreen(page, screens[1], "populated");
    let currentDecision: boolean | undefined = true;
    await mockRoute(page, "get", "/api/v1/access/me", () => ({ status: 200, json: {
      ...screenAccess("/people/new"), decisions: currentDecision === undefined ? {} : { bulk_appointment: currentDecision },
    } }));
    await mockRoute(page, "get", "/api/v1/job-titles", { status: 200, json: { items: [], can_manage: false } });
    await mockRoute(page, "get", "/api/v1/reason-codes", request => ({ status: 200, json: { domain: new URL(request.url()).searchParams.get("domain")!, items: [] } }));
    await mockRoute(page, "get", "/api/v1/appointment-notices", { status: 200, json: { items: [], next_cursor: null } });
    try {
      await page.goto(surface.path);
      await expect(page.getByRole("heading", { name: t(surface.title), exact: true })).toBeVisible();
      currentDecision = decision;
      await page.reload();
      await expect(page.getByRole("main").getByRole("region", { name: t("common.denied.title.plain"), exact: true })).toBeVisible();
      await expect(page.getByRole("heading", { name: t(surface.title), exact: true })).toHaveCount(0);
      expect(state.unexpected).toEqual([]);
    } finally { await page.close(); state.release(); }
  });
}
