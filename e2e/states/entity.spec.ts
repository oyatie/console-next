// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { expectAxe, fits } from "../a11y";
import { REGISTRATION_FIXTURES, typeAddress } from "../setup-flows";
import { mockEntityCreate } from "./entity";

test.beforeAll(() => loadCatalog("ko"));

for (const kind of ["CORPORATION", "INDIVIDUAL"] as const) {
  test(`entity-create: certificate-filled ${kind} at 1440px @ui-state`, async ({ page }) => {
    page.setDefaultTimeout(8000);
    await page.setViewportSize({ width: 1440, height: 900 });
    const fixture = await mockEntityCreate(page);
    try {
      await page.goto(`/org/entities/new?kind=${kind}&name=${encodeURIComponent("검증사업자")}`);
      await page.getByLabel(t("entityCreate.field.brn")).fill(REGISTRATION_FIXTURES.primary.brn);
      await page.getByLabel(t(kind === "CORPORATION" ? "entityCreate.field.representative" : "entityCreate.field.ownerName")).fill("김대표");
      await page.getByLabel(t("entityCreate.field.openedOn")).fill("2020-03-02");
      if (kind === "CORPORATION") await page.getByLabel(t("entityCreate.field.crn")).fill(REGISTRATION_FIXTURES.primary.crn);
      await typeAddress(page, t("entityCreate.field.businessAddress"), "검증로 123", "06236");
      await page.getByRole("radiogroup", { name: t("entityCreate.field.taxType") }).locator("label").first().click();
      await page.getByRole("textbox", { name: t("entityCreate.business.sectorOf", { n: 1 }), exact: true }).fill("정보통신업");
      await page.getByRole("textbox", { name: t("entityCreate.business.itemOf", { n: 1 }), exact: true }).fill("소프트웨어 개발");
      const group = page.getByRole("radiogroup", { name: t("entityCreate.field.unitTaxation") });
      await group.getByText(t("entityCreate.unitTaxation.yes"), { exact: true }).click();
      await page.getByLabel(t("entityCreate.field.taxOffice")).fill("삼성세무서");
      await expectAxe(page, `entity-create/certificate-filled/${kind}/1440`);
      const missing = await group.getByRole("radio").evaluateAll(radios => radios.flatMap(radio =>
        ["aria-describedby", "aria-errormessage"].flatMap(attr => (radio.getAttribute(attr) ?? "").split(/\s+/).filter(id => id && !document.getElementById(id))),
      ));
      expect(missing, "every radio description and error reference resolves").toEqual([]);
      await fits(page, `entity-create/certificate-filled/${kind}/1440`);
      expect(fixture.unexpected, "register every supporting read").toEqual([]);
    } finally {
      await page.close();
      fixture.release();
    }
  });
}
