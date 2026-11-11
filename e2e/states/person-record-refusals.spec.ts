// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { i18n, loadCatalog, t } from "@console/i18n";
import { expectAxe, fits } from "../a11y";
import { moveDetail } from "../mock/lifecycle-sheets";
import { mockRoute } from "../mock/route";
import { mockScreen } from "../mock/screen";
import { lifecycleSheetScreens } from "./lifecycle-sheets";

for (const locale of ["ko", "en"] as const) for (const width of [1440, 390]) {
  test(`person record: refused addition keeps input in ${locale} at ${width}px @ui-state`, async ({ page }) => {
    await loadCatalog(locale);
    i18n.set(locale);
    await page.addInitScript(locale => localStorage.setItem("console.locale", locale), locale);
    await page.setViewportSize({ width, height: 900 });
    const fixture = await mockScreen(page, lifecycleSheetScreens[0], "populated");
    let writes = 0;
    await mockRoute(page, "post", "/api/v1/employees/{id}/records/{section}", request => {
      writes++;
      expect(request.postDataJSON().fields).toMatchObject({ language: "한국어" });
      return { status: 409, json: { error: { code: "record_section_disabled", message: "Untranslated server message" } } };
    });
    try {
      await page.goto(`/people/${moveDetail.employee.id}`);
      await page.getByRole("button", { name: t("uiRecordActions.addOf", { object: t("empRec.language") }), exact: true }).click();
      const editor = page.getByRole("group", { name: t("empRec.newRow", { section: t("empRec.language") }), exact: true });
      const language = editor.getByRole("textbox", { name: t("empRec.language.language"), exact: true });
      await language.fill("한국어");
      await language.press("Enter");
      const alert = editor.getByRole("alert");
      await expect(alert).toContainText(t("common.failed.code.record_section_disabled"));
      await expect(alert).not.toContainText("Untranslated server message");
      await expect(language).toHaveValue("한국어");
      expect(writes).toBe(1);
      for (const theme of ["light", "dark"]) {
        await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
        await fits(page, `record refusal/${locale}/${width}/${theme}`);
        await page.screenshot({ path: test.info().outputPath(`${theme}.png`) });
      }
      await expectAxe(page, `record refusal/${locale}/${width}`);
      expect(fixture.unexpected).toEqual([]);
    } finally { await page.close(); fixture.release(); i18n.set("ko"); }
  });
}
