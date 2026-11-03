// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { expectAxe, fits } from "../a11y";
import { mockRoute } from "../mock/route";
import { orgPanelReads } from "../mock/org-work";
import { id } from "../mock/fixtures";
import { brnDisplay, REGISTRATION_FIXTURES } from "../setup-flows";
import { entityRecordPath, mockEntityRecord } from "./entity-record";
import { mockScreen } from "../mock/screen";
import { screens } from "./registry";

test.beforeAll(() => loadCatalog("ko"));

test("correction-only field keeps one action verb from row to sheet @ui-state", async ({ page }) => {
  const fixture = await mockEntityRecord(page, "populated");
  try {
    await page.goto(entityRecordPath);
    for (const key of ["openedOn", "incorporatedOn"] as const) {
      const action = t("uiRecordActions.of", {
        field: t(`entityRecord.field.${key}`),
        verb: t("uiRecordVerbs.verb.correct"),
      });
      await page.getByRole("button", { name: action, exact: true }).click();
      await expect(page.getByRole("dialog", { name: action, exact: true })).toBeVisible();
      await page.keyboard.press("Escape");
    }
    expect(fixture.unexpected).toEqual([]);
  } finally { await page.close(); fixture.release(); }
});

for (const surface of ["record", "workplace", "chart"] as const) for (const width of [1440, 390]) {
  test(`entity fields: ${surface} has one edit per row and one empty marker (${width}px) @ui-state`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const fixture = surface === "chart" ? await mockScreen(page, screens[2], "populated") : await mockEntityRecord(page, "populated");
    if (surface === "workplace") {
      const { entity } = fixture as Awaited<ReturnType<typeof mockEntityRecord>>;
      entity.workplaces[0]!.current!.opened_on = "2020-03-02";
      entity.workplaces[0]!.current!.mail_address = { source: "MANUAL_UNVERIFIED", road_addr_part1: "서울특별시 종로구 세종대로 209", si_nm: "서울특별시" };
    }
    let release = () => {};
    try {
      if (surface === "chart") {
        release = (await orgPanelReads(page)).release;
        await mockRoute(page, "get", "/api/v1/org-structure/units/{orgUnitId}/members", { status: 200, json: { headcount: 0, items: [] } });
      }
      await page.goto(surface === "chart" ? `/org?sel=${id(4)}` : surface === "workplace" ? `${entityRecordPath}?wp=${id(4102)}` : entityRecordPath);
      const main = surface === "chart" ? page.getByRole("complementary", { name: "본사", exact: true }) : page.getByRole("main");
      const rows = surface === "record" ? main.locator('[class*="_fact_"]') : main.locator('dl > div').filter({ has: page.locator("dt") });
      await expect(rows.first()).toBeVisible();
      const buttons = rows.getByRole("button");
      await expect(buttons.first()).toBeEnabled();
      expect(await rows.evaluateAll(elements => elements.filter(row => [...row.querySelectorAll("button")].filter(button => button.textContent?.trim()).length > 1).map(row => row.textContent))).toEqual([]);
      for (const button of await buttons.all()) {
        const text = (await button.innerText()).trim();
        if (text) expect([t("uiRecordActions.edit"), t("uiRecordVerbs.verb.correct")]).toContain(text);
        await expect(button).toHaveAccessibleName(/\S/);
      }
      if (surface === "record") {
        const brn = rows.filter({ has: page.getByText(t("entityRecord.field.brn"), { exact: true }) });
        await expect(brn.locator('[class*="_factValue_"]')).toHaveText(brnDisplay(REGISTRATION_FIXTURES.primary.brn));
        await expect(brn.getByRole("button", { name: t("uiRecordActions.of", { field: t("entityRecord.field.brn"), verb: t("uiRecordVerbs.verb.correct") }), exact: true })).toBeVisible();
        await expect(main.locator('[class*="_nameProblems_"]:empty')).toHaveCount(0);
      }
      const openedField = t(surface === "record" ? "entityRecord.field.openedOn" : "workplace.field.openedOn");
      const opened = rows.filter({ has: page.getByText(openedField, { exact: true }) });
      await expect(opened.getByRole("button", { name: t("uiRecordActions.of", { field: openedField, verb: t("uiRecordVerbs.verb.correct") }), exact: true })).toBeVisible();
      if (surface === "workplace") {
        const field = t("entityOps.info.mail");
        const mail = rows.filter({ has: page.getByText(field, { exact: true }) });
        await mail.getByRole("button", { name: t("uiRecordActions.more", { field }), exact: true }).click();
        await page.getByRole("menuitem", { name: t("uiRecordActions.end.clear"), exact: true }).click();
        const clear = page.getByRole("dialog", { name: t("uiRecordActions.of", { field, verb: t("uiRecordActions.end.clear") }), exact: true });
        await expect(clear.getByRole("combobox", { name: field })).toHaveValue("");
        await page.keyboard.press("Escape");
        await page.getByRole("main").evaluate(element => element.scrollTo(0, 0));
      }
      const emptyFields = surface === "record" ? ["entityRecord.field.liquor", "entityRecord.vat.mainKsic", "entityRecord.field.issued"] as const : ["workplace.create.kind", "workplace.code.field"] as const;
      for (const key of emptyFields) {
        const row = rows.filter({ hasText: t(key) });
        const value = surface === "record" ? row.locator('[class*="_factValue_"]') : row.locator("dd").first();
        await expect(value).toHaveText(t("entityOps.info.none"));
      }
      for (const theme of ["light", "dark"]) {
        await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
        await page.screenshot({ path: test.info().outputPath(`${surface}-${width}-${theme}.png`), fullPage: true });
        await fits(page, `entity fields/${surface}/${width}/${theme}`);
        await expectAxe(page, `entity fields/${surface}/${width}/${theme}`);
      }
      expect(fixture.unexpected).toEqual([]);
    } finally { release(); await page.close(); fixture.release(); }
  });
}

for (const [issuedOn, taxOffice] of [[null, null], ["2026-01-02", null], [null, "검증세무서"], ["2026-01-02", "검증세무서"]] as const) {
  test(`entity certificate: issue date ${issuedOn ?? "absent"}, tax office ${taxOffice ?? "absent"} @ui-state`, async ({ page }) => {
    const fixture = await mockEntityRecord(page, "populated");
    fixture.entity.registrations[0]!.current = {
      version: 1, effective_from: "2026-01-01", before_first_record: false, trade_name: "주식회사 검증법인",
      business_types: [], status: "CONTINUING", change_mode: "SETUP", cert_issued_on: issuedOn, tax_office_label: taxOffice,
    };
    try {
      await page.goto(entityRecordPath);
      const row = page.getByRole("main").locator('[class*="_fact_"]').filter({ hasText: t("entityRecord.field.issued") });
      const date = issuedOn ? fmtDate(issuedOn) : "";
      const expected = date && taxOffice ? `${date} · ${taxOffice}` : date || taxOffice || t("entityOps.info.none");
      await expect(row.locator('[class*="_factValue_"]')).toHaveText(expected);
      expect(fixture.unexpected).toEqual([]);
    } finally { await page.close(); fixture.release(); }
  });
}
