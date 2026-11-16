// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { expectAxe } from "../a11y";
import { go } from "../flows";
import { failure, id, screenAccess } from "../mock/fixtures";
import { orgPanelReads, orgWorkReads } from "../mock/org-work";
import { mockRoute } from "../mock/route";
import { mockScreen } from "../mock/screen";
import { screens } from "./registry";

test.beforeAll(() => loadCatalog("ko"));

for (const act of ["wp-create", "wp-close", "wp-kind"] as const) for (const width of [1440, 390]) for (const theme of ["light", "dark"]) {
  test(`${act} keeps cached read notices and drafts inside its sheet at ${width}px in ${theme} @ui-state`, async ({ page, context }, info) => {
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
    let failed = false;
    const path = act === "wp-create" ? `legal-entities/${id(3)}` : act === "wp-close" ? `workplaces/${id(4)}/close-plan` : "workplace-kinds";
    await page.route(`**/api/v1/${path}`, route => failed
      ? route.fulfill({ status: 503, json: failure("service_unavailable") }) : route.fallback());
    const selected = act === "wp-create" ? id(3) : id(4);
    const title = act === "wp-create" ? t("workplace.add") : t(act === "wp-close" ? "workplace.close.title" : "workplace.kind.title", { name: "본사" });
    const chart = page.getByRole("region", { name: t("structure.chart.label"), exact: true, includeHidden: true });
    const chartSize = () => chart.evaluate(element => {
      const { width, height } = element.getBoundingClientRect();
      return { width, height };
    });
    try {
      await go(page, `/org?sel=${selected}`);
      await page.evaluate(() => document.fonts.ready);
      // Connectivity also changes page chrome; compare the sheet against the same offline page.
      await context.setOffline(true);
      await expect(page.getByText(t("common.read.offline"), { exact: true }).first()).toBeVisible();
      const offlineSize = await chartSize();
      await context.setOffline(false);
      await go(page, `/org?sel=${selected}&act=${act}`);
      const sheet = page.getByRole("dialog", { name: title, exact: true });
      const fitsSheet = async () => expect(await sheet.evaluate(element => {
        const bounds = element.getBoundingClientRect();
        return bounds.left >= 0 && bounds.right <= innerWidth
          && [element, ...element.querySelectorAll('[role="status"]')].every(region => region.scrollWidth <= region.clientWidth);
      }), "the sheet and its read notice fit the viewport").toBe(true);
      const field = act === "wp-create" ? sheet.getByLabel(t("workplace.field.name"))
        : act === "wp-close" ? sheet.getByRole("textbox", { name: new RegExp(t("workplace.close.date")) }) : sheet.getByRole("button", { name: t("workplace.kinds.title"), exact: true });
      await expect(field).toBeVisible();
      if (act === "wp-create") await field.fill("새 사업장");
      await field.focus();
      const fieldBox = await field.boundingBox();
      const mountedField = await field.elementHandle();
      const readyBox = await chart.boundingBox();
      await context.setOffline(true);
      const notices = sheet.getByRole("status").filter({ hasText: t("common.read.offline") });
      await expect(notices).toHaveCount(1);
      await expect(notices.first()).toBeVisible();
      expect(await field.boundingBox()).toEqual(fieldBox);
      expect(await chartSize()).toEqual(offlineSize);
      await expect(page.getByRole("dialog")).toHaveCount(1);
      await expect(field).toBeFocused();
      await fitsSheet();
      await expectAxe(page, "offline sheet");
      await page.screenshot({ path: info.outputPath("offline.png") });
      failed = true;
      await notices.getByRole("button", { name: t("common.retry"), exact: true }).click();
      await context.setOffline(false);
      const stale = sheet.getByRole("status").filter({ hasText: t("common.read.stale") });
      await expect(stale).toHaveCount(1, { timeout: 15_000 });
      await expect(stale).toBeVisible();
      expect(await field.boundingBox()).toEqual(fieldBox);
      await expect(page.getByRole("dialog")).toHaveCount(1);
      expect(await chart.boundingBox()).toEqual(readyBox);
      expect(await mountedField!.evaluate(element => element.isConnected)).toBe(true);
      if (act === "wp-create") await expect(field).toHaveValue("새 사업장");
      await page.screenshot({ path: info.outputPath("stale.png") });
      await fitsSheet();
      await expectAxe(page, "stale sheet");
      failed = false;
      await stale.getByRole("button", { name: t("common.retry"), exact: true }).click();
      await expect(stale).toHaveCount(0);
      expect(await field.boundingBox()).toEqual(fieldBox);
      expect(await mountedField!.evaluate(element => element.isConnected)).toBe(true);
      if (act === "wp-create") await expect(field).toHaveValue("새 사업장");
      expect(await chart.boundingBox()).toEqual(readyBox);
      expect(fixture.unexpected).toEqual([]);
    } finally { await context.setOffline(false); await page.close(); fixture.release(); }
  });
}
