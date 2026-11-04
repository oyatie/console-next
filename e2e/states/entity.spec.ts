// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { expectAxe, fits } from "../a11y";
import { mockRoute } from "../mock/route";
import { REGISTRATION_FIXTURES, typeAddress } from "../setup-flows";
import { mockEntityCreate } from "./entity";
import { entityRecord } from "./entity-record";

test.beforeAll(() => loadCatalog("ko"));

for (const kind of ["CORPORATION", "INDIVIDUAL"] as const) for (const width of [1440, 390]) {
  test(`entity-create: certificate states for ${kind} at ${width}px @ui-state`, async ({ page }) => {
    page.setDefaultTimeout(8000);
    await page.setViewportSize({ width, height: 900 });
    const fixture = await mockEntityCreate(page);
    if (kind === "CORPORATION") await mockRoute(page, "get", "/api/v1/legal-entities", { status: 200, json: { items: [entityRecord("populated")] } });
    try {
      await page.goto(`/org/entities/new?kind=${kind}&name=${encodeURIComponent("검증사업자")}`);
      await expectAxe(page, `entity-create/${kind === "CORPORATION" ? "certificate" : "individual"}/${width}`);
      const brn = page.getByLabel(t("entityCreate.field.brn"));
      const opened = page.getByLabel(t("entityCreate.field.openedOn"));
      const business = page.getByRole("group", { name: t("entityCreate.business.label"), exact: true });
      const sector = business.getByRole("textbox", { name: t("entityCreate.business.sectorOf", { n: 1 }), exact: true });
      const item = business.getByRole("textbox", { name: t("entityCreate.business.itemOf", { n: 1 }), exact: true });
      const office = page.getByLabel(t("entityCreate.field.taxOffice"));
      if (width === 390) {
        await expect(business.getByText(t("entityCreate.business.main"), { exact: true })).toHaveCSS("justify-self", "start");
        for (const key of ["kind", "sector", "item", "ksic"] as const)
          await expect(sector.locator("..").getByText(t(`entityCreate.business.${key}`), { exact: true })).toBeVisible();
      }
      if (kind === "CORPORATION") {
        await office.focus();
        await expectAxe(page, `entity-create/tax-office/${width}`);
        await sector.fill("정보통신업");
        await item.fill("소프트웨어 개발");
        await expectAxe(page, `entity-create/business-rows/${width}`);
        await sector.clear();
        await item.clear();
        await brn.fill(REGISTRATION_FIXTURES.primary.brn);
        await expect(page.getByRole("link", { name: t("entityCreate.brn.openTaken") })).toBeVisible();
        await expectAxe(page, `entity-create/duplicate/${width}`);
        await brn.fill(REGISTRATION_FIXTURES.second.brn);
        await opened.fill("2099-03-02");
        await opened.press("Tab");
        await expect(opened).toHaveAttribute("aria-invalid", "true");
        await expectAxe(page, `entity-create/validation/${width}`);
        await opened.fill("2020-03-02");
        await page.getByLabel(t("entityCreate.field.representative")).fill("김대표");
        await page.getByLabel(t("entityCreate.field.crn")).fill(REGISTRATION_FIXTURES.primary.crn);
      } else {
        await brn.fill(REGISTRATION_FIXTURES.primary.brn);
        await opened.fill("2020-03-02");
        await page.getByLabel(t("entityCreate.field.ownerName")).fill("김대표");
      }
      await typeAddress(page, t("entityCreate.field.businessAddress"), "검증로 123", "06236");
      await page.getByRole("radiogroup", { name: t("entityCreate.field.taxType") }).locator("label").first().click();
      await sector.fill("정보통신업");
      await item.fill("소프트웨어 개발");
      const group = page.getByRole("radiogroup", { name: t("entityCreate.field.unitTaxation") });
      await group.getByText(t("entityCreate.unitTaxation.yes"), { exact: true }).click();
      await office.fill("삼성세무서");
      if (kind === "INDIVIDUAL") await expectAxe(page, `entity-create/individual-filled/${width}`);
      const missing = await group.getByRole("radio").evaluateAll(radios => radios.flatMap(radio =>
        ["aria-describedby", "aria-errormessage"].flatMap(attr => (radio.getAttribute(attr) ?? "").split(/\s+/).filter(id => id && !document.getElementById(id))),
      ));
      expect(missing, "every radio description and error reference resolves").toEqual([]);
      await fits(page, `entity-create/${kind}/${width}`);
      expect(fixture.unexpected, "register every supporting read").toEqual([]);
    } finally {
      await page.close();
      fixture.release();
    }
  });
}
