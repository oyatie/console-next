// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { expectAxe } from "../a11y";
import { AT, id } from "../mock/fixtures";
import { unplacedTarget } from "../mock/lifecycle-sheets";
import { mockRoute } from "../mock/route";
import { mockScreen } from "../mock/screen";
import { screens } from "./registry";

test.beforeAll(() => loadCatalog("ko"));

for (const width of [1440, 390]) for (const path of ["/people/run", "/people/unplaced"]) {
  test(`placement list exposes its surroundings on ${path} at ${width}px @ui-state`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    const fixture = await mockScreen(page, screens[1], "populated");
    await mockRoute(page, "get", "/api/v1/legal-entities", { status: 200, json: { items: [unplacedTarget.entity] } });
    await mockRoute(page, "get", "/api/v1/org-structure", { status: 200, json: unplacedTarget.structure });
    await mockRoute(page, "get", "/api/v1/org-units", { status: 200, json: { items: [
      { id: id(4002), name: "본사", kind: "SITE", parentId: null, status: "ACTIVE", effectiveFrom: "2026-01-01", headcount: 2, updatedAt: AT },
      { id: id(4003), name: "인사팀", kind: "DEPARTMENT", parentId: id(4002), status: "ACTIVE", effectiveFrom: "2026-01-01", headcount: 2, updatedAt: AT },
    ] } });
    await mockRoute(page, "get", "/api/v1/employees/import/unplaced", { status: 200, json: { count: 1, next_cursor: null, items: [
      { employee_id: id(100), name: "검증직원", company: "화면 검증 회사", legal_entity_id: id(4001), reason: "no_place", source_workplace: "본사" },
    ] } });
    await mockRoute(page, "get", "/api/v1/employment-assignments/unmapped-companies", { status: 200, json: { items: [] } });
    try {
      await page.goto(path);
      const name = path === "/people/run" ? t("register.run.cell", { n: 1, field: t("register.run.col.place") }) : t("unplaced.target.findLabel");
      const input = page.getByRole("combobox", { name, exact: true });
      await input.scrollIntoViewIfNeeded();
      await input.focus();
      // Finish the phone focus scroll before opening a popover that closes on outside scroll.
      await page.evaluate(() => document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))));
      await input.press("ArrowDown");
      await expect(page.getByRole("listbox").getByRole("option").first()).toBeVisible();
      await expectAxe(page, `placement list ${path} ${width}`);
      const bounds = (await page.getByRole("listbox").boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      for (const theme of ["light", "dark"]) {
        await page.locator("html").evaluate((el, value) => { el.dataset.theme = value; }, theme);
        await page.screenshot({ path: info.outputPath(`list-${width}-${theme}.png`), fullPage: true });
      }
      await input.press("Escape");
      await expect(input).toHaveAttribute("aria-expanded", "false");
      expect(fixture.unexpected).toEqual([]);
    } finally { await page.close(); fixture.release(); }
  });
}
