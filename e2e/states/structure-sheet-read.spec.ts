// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { expectAxe, fits } from "../a11y";
import { go } from "../flows";
import { failure, id, screenAccess } from "../mock/fixtures";
import { orgPanelReads, orgWorkReads } from "../mock/org-work";
import { mockRoute } from "../mock/route";
import { mockScreen } from "../mock/screen";
import { screens } from "./registry";

test.beforeAll(() => loadCatalog("ko"));

for (const act of ["wp-create", "wp-close", "wp-kind"] as const) for (const width of [1440, 390]) for (const theme of ["light", "dark"]) {
  test(`${act} sheet reads leave the chart in place at ${width}px in ${theme} @ui-state`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(value => localStorage.setItem("console.theme", value), theme);
    const fixture = await mockScreen(page, screens[2], "populated");
    await orgPanelReads(page);
    await orgWorkReads(page, "setup");
    await mockRoute(page, "get", "/api/v1/ref/lists/{key}/codes", request => ({ status: 200, json: {
      list: { key: new URL(request.url()).pathname.split("/").at(-2)!, status: "NOT_LOADED" as const }, items: [],
    } }));
    await mockRoute(page, "get", "/api/v1/access/me", { status: 200, json: { ...screenAccess("/org", "SETUP"), is_ops: true } });
    await mockRoute(page, "get", "/api/v1/workplaces/{workplaceId}/close-plan", { status: 200, json: {
      workplace_id: id(4), legal_entity_id: id(3), site_org_unit_id: null, closed_on: null,
      holds_entity_role: false, people: [], units: [], exit_cases: [], job: null,
    } });
    const selected = act === "wp-create" ? id(3) : id(4);
    const title = act === "wp-create" ? t("workplace.add") : t(act === "wp-close" ? "workplace.close.title" : "workplace.kind.title", { name: "본사" });
    const path = act === "wp-create" ? `legal-entities/${id(3)}` : act === "wp-close" ? `workplaces/${id(4)}/close-plan` : "workplace-kinds";
    const held = Promise.withResolvers<void>();
    let failed = true;
    let refused = 0;
    const holdRead = () => page.route(`**/api/v1/${path}`, async route => {
      await held.promise;
      if (refused) await route.fulfill({ status: refused, json: failure(refused === 403 ? "forbidden" : "not_found") });
      else if (failed) await route.fulfill({ status: 503, json: failure("service_unavailable") });
      else await route.fallback();
    });
    const chart = page.getByRole("region", { name: t("structure.chart.label"), exact: true, includeHidden: true });
    const chartBox = () => chart.evaluate(element => {
      const rect = element.getBoundingClientRect();
      let { x, y } = rect;
      // Dismissal restores focus in the panel, which can scroll the main column.
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        x += parent.scrollLeft;
        y += parent.scrollTop;
      }
      return { x, y, width: rect.width, height: rect.height };
    });
    let opened: Promise<void> | undefined;
    try {
      // The workplace panel preloads kinds; hold that first read to exercise its pending sheet.
      if (act === "wp-kind") await holdRead();
      await (act === "wp-kind" ? page.goto(`/org?sel=${selected}`) : go(page, `/org?sel=${selected}`));
      // The held kinds read prevents routeReady; wait for the committed UI instead.
      if (act === "wp-kind") await page.getByRole("tree", { includeHidden: true }).waitFor();
      await expect(page.getByRole("tree", { includeHidden: true })).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      const before = await chartBox();
      if (act !== "wp-kind") await holdRead();
      opened = act === "wp-kind" ? page.goto(`/org?sel=${selected}&act=${act}`).then(() => undefined) : go(page, `/org?sel=${selected}&act=${act}`);
      const pendingSheet = page.getByRole("dialog", { name: title, exact: true });
      if (act === "wp-kind") await pendingSheet.waitFor();
      await expect(pendingSheet.getByRole("status", { name: t("common.loading"), exact: true })).toBeVisible();
      expect(await chartBox()).toEqual(before);
      await fits(page, "pending workplace sheet");
      await page.screenshot({ path: info.outputPath("loading.png") });
      await pendingSheet.getByRole("button", { name: t("uiSheet.close"), exact: true }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      expect(await chartBox()).toEqual(before);
      await page.goBack();
      await expect(pendingSheet).toBeVisible();
      held.resolve();
      await expect(pendingSheet.getByRole("alert")).toContainText(t("common.loadFailed.title"), { timeout: 15_000 });
      expect(await chartBox()).toEqual(before);
      await expect(pendingSheet).toHaveCount(1);
      await expectAxe(page, "failed workplace sheet read");
      await page.screenshot({ path: info.outputPath("failed.png") });
      failed = false;
      await pendingSheet.getByRole("button", { name: t("common.retry"), exact: true }).click();
      const sheet = page.getByRole("dialog", { name: title, exact: true });
      if (act === "wp-create") await expect(sheet.getByLabel(t("workplace.field.name"))).toBeVisible();
      else if (act === "wp-close") await expect(sheet.getByRole("textbox", { name: new RegExp(t("workplace.close.date")) })).toBeVisible();
      else await expect(sheet.getByRole("button", { name: t("workplace.kinds.title"), exact: true })).toBeVisible();
      await expect(page.getByRole("dialog")).toHaveCount(1);
      expect(await chartBox()).toEqual(before);
      await expectAxe(page, "ready workplace sheet");
      await fits(page, `workplace sheet ${width} ${theme}`);
      await page.screenshot({ path: info.outputPath("workplace-sheet.png") });
      await sheet.getByRole("button", { name: t("uiSheet.close"), exact: true }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      expect(await chartBox()).toEqual(before);
      for (const status of act === "wp-kind" ? [] : [403, 404]) {
        refused = status;
        await page.goBack();
        await expect(sheet.getByText(t(status === 403 ? "common.denied.title.plain" : "common.read.notFound.title"), { exact: true }).first()).toBeVisible();
        await expect(page.getByRole("dialog")).toHaveCount(1);
        expect(await chartBox()).toEqual(before);
        await fits(page, `refused workplace sheet ${status}`);
        await page.screenshot({ path: info.outputPath(`refused-${status}.png`) });
        await page.keyboard.press("Escape");
        await expect(page.getByRole("dialog")).toHaveCount(0);
      }
      expect(fixture.unexpected).toEqual([]);
    } finally { held.resolve(); await opened; await page.close(); fixture.release(); }
  });
}
