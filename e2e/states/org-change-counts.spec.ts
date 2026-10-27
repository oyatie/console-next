// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { mockScreen } from "../mock/screen";
import { orgChangeScreens } from "./registry";
import { expectAxe } from "../a11y";
import { user } from "../mock/fixtures";

test.beforeAll(() => loadCatalog("ko"));
const orgChangeList = orgChangeScreens[0];

for (const width of [1440, 390]) {
  for (const state of ["loading", "failed"] as const) test(`org-change counts: ${state} at ${width}px @ui-state`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const fixture = await mockScreen(page, orgChangeList, state);
    try {
      await page.goto(orgChangeList.path);
      const main = page.getByRole("main");
      if (state === "loading") await expect(main.locator('[aria-busy="true"]').last()).toBeVisible();
      else await expect(main.getByText(t("common.loadFailed.title"), { exact: true })).toBeVisible({ timeout: 20_000 });
      const views = main.getByRole("group", { name: t("orgChange.list.views") });
      for (const view of ["open", "mine", "ready", "done", "cancelled", "all"] as const) {
        const button = views.getByRole("button", { name: t(`orgChange.list.view.${view}`, { count: state === "failed" ? "—" : "" }).trim(), exact: true });
        await expect(button).toBeVisible();
        if (state === "loading") await expect(button.locator('[aria-hidden="true"]')).toHaveCount(1);
        else await expect(button.locator("[title]")).toHaveAttribute("title", t("orgChange.list.countFailed"));
      }
      if (state === "loading") {
        fixture.release();
        await expect(views.getByRole("button", { name: t("orgChange.list.view.all", { count: 3 }), exact: true })).toBeVisible();
      }
      await expectAxe(page, `org-change-counts/${state}/${width}`);
      expect(fixture.unexpected).toEqual([]);
    } finally {
      await page.close();
      fixture.release();
    }
  });

  for (const [from, to, ownCode] of [["2026-11-01", "2026-11-02", "OC-2026-0001"], ["2026-11-02", "2026-11-03", "OC-2026-0003"]]) {
    test(`org-change filters: ${from} through ${to} at ${width}px @ui-state`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      const fixture = await mockScreen(page, orgChangeList, "populated");
      try {
        await page.goto(`${orgChangeList.path}&effective_from=${from}&effective_to=${to}`);
        const main = page.getByRole("main");
        const views = main.getByRole("group", { name: t("orgChange.list.views") });
        const rows = main.getByRole("table", { name: t("orgChange.list.title") }).locator("tbody > tr");
        await expect(rows).toHaveCount(2);
        const mine = views.getByRole("button", { name: t("orgChange.list.view.mine", { count: 1 }), exact: true });
        const requested = page.waitForRequest(request => {
          const url = new URL(request.url());
          return url.pathname === orgChangeList.read && url.searchParams.get("limit") === "50" && url.searchParams.get("drafted_by") === user.id && url.searchParams.get("effective_from") === from && url.searchParams.get("effective_to") === to;
        });
        await mine.click();
        await requested;
        await expect(rows).toHaveCount(1);
        await expect(rows.getByRole("link", { name: ownCode, exact: true })).toBeVisible();
        await main.getByRole("button", { name: new RegExp(t("asof.clearRange")) }).click();
        await expect(page).toHaveURL(/\/org\/changes\?view=mine$/);
        await expect(rows).toHaveCount(2);
        await expect(rows.getByRole("link", { name: "OC-2026-0001", exact: true })).toBeVisible();
        await expect(rows.getByRole("link", { name: "OC-2026-0003", exact: true })).toBeVisible();
        expect(fixture.unexpected).toEqual([]);
      } finally {
        await page.close();
        fixture.release();
      }
    });
  }
}
