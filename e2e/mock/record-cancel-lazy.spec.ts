// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { expectAxe, fits } from "../a11y";
import { clearShifts, expectStable, recordShifts } from "../stability";
import { lifecycleSheetScreens } from "../states/lifecycle-sheets";
import { moveDetail } from "./lifecycle-sheets";
import { mockRoute } from "./route";
import { mockScreen } from "./screen";

test.beforeAll(() => loadCatalog("ko"));

for (const width of [1440, 390]) {
  test(`registration cancellation loads on click without moving the card at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(recordShifts);
    const fixture = await mockScreen(page, lifecycleSheetScreens[0], "populated");
    await mockRoute(page, "get", "/api/v1/employees/{id}/end-options", { status: 200, json: {
      employee_id: moveDetail.employee.id, phase: "SETUP", cancel_route: "DELETE",
      cancel: { allowed: true }, exit: { allowed: true }, can_cancel: true, can_report_exit: true,
      attestation_required: false, register_confirmation_required: false, updated_at: moveDetail.employee.updated_at,
    } });
    let requested = false;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    await page.route(/\/assets\/person-act-[^/]+\.js$/, async route => {
      requested = true;
      await held;
      await route.continue();
    });
    try {
      await page.goto(`/people/${moveDetail.employee.id}`);
      const cancel = page.getByRole("button", { name: t("crud.person.cancel"), exact: true });
      await expect(cancel).toBeEnabled();
      await cancel.scrollIntoViewIfNeeded();
      await expectStable(page, "record before cancellation");
      expect(requested, "action code is deferred until interaction").toBe(false);
      const position = await cancel.boundingBox();
      await page.evaluate(clearShifts);
      await cancel.click();
      await expect.poll(() => requested, { message: "cancellation requests the lazy action chunk" }).toBe(true);
      await expect(page.getByRole("dialog")).toHaveCount(0);
      expect(await cancel.boundingBox()).toEqual(position);
      await expectStable(page, "record while cancellation code loads");
      release();
      const sheet = page.getByRole("dialog", { name: t("crud.person.cancelTitle", { name: moveDetail.employee.name }), exact: true });
      await expect(sheet).toBeVisible();
      await expect(sheet.getByRole("radiogroup", { name: t("crud.person.cancelWhy") })).toBeVisible();
      await expectStable(page, "loaded cancellation sheet");
      for (const theme of ["light", "dark"]) {
        await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
        await fits(page, `cancellation/${width}/${theme}`);
        await page.screenshot({ path: test.info().outputPath(`${theme}.png`) });
      }
      await expectAxe(page, "cancellation sheet");
      await page.keyboard.press("Escape");
      await expect(sheet).toBeHidden();
      await expect(cancel).toBeFocused();
      expect(await cancel.boundingBox()).toEqual(position);
      await cancel.click();
      await expect(sheet).toBeVisible();
      expect(fixture.unexpected).toEqual([]);
    } finally { release(); await page.close(); fixture.release(); }
  });
}
