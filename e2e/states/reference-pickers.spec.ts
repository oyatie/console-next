// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import type { components } from "@console/api";
import { loadCatalog, t } from "@console/i18n";
import { expectAxe, fits } from "../a11y";
import { AT, authz, id, user } from "../mock/fixtures";
import { orgPanelReads } from "../mock/org-work";
import { mockRoute } from "../mock/route";
import { mockScreen } from "../mock/screen";
import { screens } from "./registry";

const units: components["schemas"]["OrgUnitHead"][] = ([
  [4, "본사", "SITE", null],
  [100, "검증부서 1", "DEPARTMENT", 4],
  [101, "검증부서 2", "DEPARTMENT", 4],
  [102, "검증부서 3", "DEPARTMENT", 4],
] as const).map(([n, name, kind, parent]) => ({
  id: id(n), name, kind, parentId: parent === null ? null : id(parent), status: "ACTIVE",
  effectiveFrom: "2026-01-01", headcount: 1, updatedAt: AT,
}));

test.beforeAll(() => loadCatalog("ko"));

for (const host of ["move", "reassign", "bulk"] as const) for (const width of [1440, 390]) {
  test(`unit list exposes its surroundings in ${host} at ${width}px @ui-state`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    const fixture = await mockScreen(page, screens[host === "bulk" ? 1 : 2], "populated");
    if (host !== "bulk") await orgPanelReads(page);
    else await mockRoute(page, "get", "/api/v1/me/authz", { status: 200, json: { ...authz, capabilities: [...authz.capabilities, { feature: "employee_directory_manage", permission: "allow", branch_scope: { kind: "all" }, org_wide: true, scoped: false }] } });
    await mockRoute(page, "get", "/api/v1/org-units", { status: 200, json: { items: units } });
    await mockRoute(page, "get", "/api/v1/access/me", { status: 200, json: { account_id: user.id, is_ops: true, phase: "OPERATING", as_of: AT, entries: [] } });
    await mockRoute(page, "get", "/api/v1/reason-codes", request => ({ status: 200, json: { domain: new URL(request.url()).searchParams.get("domain")!, items: [] } }));
    await mockRoute(page, "get", "/api/v1/job-titles", { status: 200, json: { items: [], can_manage: false } });
    try {
      await page.goto(host === "bulk" ? "/people?bulk=paste" : `/org?sel=${id(100)}&act=${host}`);
      const sheet = page.getByRole("dialog");
      await expect(sheet).toBeVisible({ timeout: 20_000 });
      if (host === "bulk") await sheet.getByRole("radio", { name: t("enum.lifecycleEvent.TRANSFER"), exact: true }).press("Space");
      const input = sheet.getByRole("combobox", { name: t(host === "move" ? "orgPropose.field.parent" : host === "reassign" ? "orgPropose.field.to" : "bulk.unit"), exact: true });
      await input.scrollIntoViewIfNeeded();
      await input.focus();
      // Phone focus scrolling must settle before opening a popup that closes on outside scroll.
      await page.evaluate(() => document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))));
      await input.press("ArrowDown");
      await expect(page.getByRole("listbox").getByRole("option").first()).toBeVisible();
      await expect(sheet.getByRole("button", { name: t("uiSheet.close"), exact: true })).toBeVisible();
      await expectAxe(page, `unit list ${host}/${width}`);
      await fits(page, `unit list ${host}/${width}`);
      const bounds = (await page.getByRole("listbox").boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      for (const theme of ["light", "dark"]) {
        await page.locator("html").evaluate((el, value) => { el.dataset.theme = value; }, theme);
        await page.screenshot({ path: info.outputPath(`unit-list-${width}-${theme}.png`), fullPage: true });
      }
      await input.press("Tab");
      await expect(input).toHaveAttribute("aria-expanded", "false");
      await expect(sheet).toBeVisible();
      expect(fixture.unexpected).toEqual([]);
    } finally {
      await page.close();
      fixture.release();
    }
  });
}
