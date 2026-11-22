// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect } from "@playwright/test";
import { t, loadCatalog } from "@console/i18n";
import { expectAxe, fits } from "../a11y";
import { test } from "../locale-fixture";
import { mockRoute } from "../mock/route";
import { mockScreen } from "../mock/screen";
import { saeonTeamAccess, saeonTeamEmployees, saeonTeamFacets, saeonTeamLeaveQueue, enableConsole } from "../mock/saeon-mod5-6";
import { screens } from "./registry";

test.beforeAll(() => loadCatalog("ko"));

const teamScreen = screens.find(s => s.key === "team")!;

for (const state of ["empty", "loading", "failed", "refused", "populated"] as const) {
  test(`/team state matrix: ${state} stays reachable and accessible`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await enableConsole(page, "light");
    const fixture = await mockScreen(page, teamScreen, state);
    await mockRoute(page, "get", "/api/v1/access/me", { status: 200, json: saeonTeamAccess({ concurrent: true }) });
    if (state === "populated") {
      const empPage = saeonTeamEmployees();
      await mockRoute(page, "get", "/api/v1/employees", { status: 200, json: empPage });
      await mockRoute(page, "get", "/api/v1/employees/facets", { status: 200, json: saeonTeamFacets() });
      await mockRoute(page, "get", "/api/v2/leave/requests", { status: 200, json: saeonTeamLeaveQueue(empPage.items) });
    }

    try {
      await page.goto(teamScreen.path);
      await expect(page.getByRole("heading", { level: 1, name: t("team.title"), exact: true })).toBeVisible();
      if (state === "loading") {
        await expect(page.getByRole("status", { name: t("common.loading"), exact: true })).toBeVisible();
        await fits(page, "team loading");
        await expectAxe(page, "team loading");
        fixture.release();
      } else if (state === "empty") {
        await expect(page.getByRole("heading", { name: t("team.empty.title"), exact: true })).toBeVisible();
        await fits(page, "team empty");
        await expectAxe(page, "team empty");
      } else if (state === "failed") {
        await expect(page.getByRole("heading", { name: t("common.loadFailed.title"), exact: true })).toBeVisible();
        await fits(page, "team failed");
        await expectAxe(page, "team failed");
        const empPage = saeonTeamEmployees();
        await mockRoute(page, "get", "/api/v1/employees", { status: 200, json: empPage });
        await page.getByRole("button", { name: t("common.retry"), exact: true }).click();
        await expect(page.getByText(empPage.items[0]!.name, { exact: true }).first()).toBeVisible();
      } else if (state === "refused") {
        await expect(page.getByRole("heading", { name: t("common.denied.title.plain"), exact: true })).toBeVisible();
        await fits(page, "team refused");
        await expectAxe(page, "team refused");
      } else {
        await expect(page.getByRole("grid", { name: t("team.table.label"), exact: true })).toBeVisible();
        await fits(page, "team populated");
        await expectAxe(page, "team populated");
      }
      expect(fixture.unexpected).toEqual([]);
    } finally {
      fixture.release();
    }
  });
}
