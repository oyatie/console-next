// SPDX-License-Identifier: LicenseRef-Proprietary
import { i18n, loadCatalog, t } from "@console/i18n";
import { expect, test } from "@playwright/test";
import { expectAxe, fits } from "../a11y";
import { filingTask, mockFilings } from "../mock/filings";
import { failure } from "../mock/fixtures";
import { mockRoute } from "../mock/route";
import { mockScreen } from "../mock/screen";
import { screens } from "./registry";

for (const locale of ["ko", "en"] as const) for (const width of [1440, 390]) {
  test(`citation destinations are inert and unsafe URLs are refused in ${locale} at ${width}px @ui-state`, async ({ page }, info) => {
    await loadCatalog(locale); i18n.set(locale);
    await page.setViewportSize({ width, height: 1000 });
    await page.addInitScript(({ locale, width }) => {
      localStorage.setItem("console.locale", locale);
      localStorage.setItem("console.theme", width === 390 ? "dark" : "light");
    }, { locale, width });
    const fixture = await mockScreen(page, screens[2], "populated");
    const citation = filingTask.basis!.citation;
    await mockFilings(page, { ...filingTask, basis: { ...filingTask.basis!,
      applicability_citations: [{ ...citation, article: "제22조", source_url: "http://example.com/unsafe" }],
      penalty: { per_worker: true, delay_won: [10000], cap_won: null,
        citation: { ...citation, article: "제23조", source_url: "javascript:alert(1)" } },
    } });
    try {
      await page.goto("/statutory");
      const row = page.getByRole("row").filter({ hasText: filingTask.name });
      await row.getByText(t("statutory.basis"), { exact: true }).click();
      await expect(row.getByRole("link", { name: /국민연금법/ })).toHaveCount(0);
      await expect(row.getByText(`국민연금법 · 제21조 · ${new URL(citation.source_url).href}`, { exact: true })).toBeVisible();
      await expect(row.getByRole("button", { name: t("uiField.copyUrl"), exact: true })).toHaveCount(0);
      await expect(row.locator('[data-refusal-code="external_url_https_required"]')).toHaveCount(2);
      for (const refusal of await row.locator('[data-refusal-code="external_url_https_required"]').all()) {
        await expect(refusal).toContainText(t("common.failed.code.external_url_https_required"));
      }
      await fits(page, "citation destinations");
      await expectAxe(page, "citation destinations");
      await page.screenshot({ path: info.outputPath("citation-destinations.png"), fullPage: true });
      expect(fixture.unexpected).toEqual([]);
    } finally { await page.close(); fixture.release(); }
  });

  test(`invalid stored citation explains the read refusal in ${locale} at ${width}px @ui-state`, async ({ page }) => {
    await loadCatalog(locale); i18n.set(locale);
    await page.setViewportSize({ width, height: 1000 });
    await page.addInitScript(({ locale, width }) => {
      localStorage.setItem("console.locale", locale);
      localStorage.setItem("console.theme", width === 390 ? "dark" : "light");
    }, { locale, width });
    const fixture = await mockScreen(page, screens[2], "populated");
    await mockFilings(page);
    await mockRoute(page, "get", "/api/v1/statutory/insurance-filings", {
      status: 503, json: failure("filing_citation_source_url_invalid"),
    });
    try {
      await page.goto("/statutory");
      await expect(page.getByText(t("common.failed.code.filing_citation_source_url_invalid"), { exact: true })).toBeVisible({ timeout: 20_000 });
      await fits(page, "citation refusal");
      expect(fixture.unexpected).toEqual([]);
    } finally { await page.close(); fixture.release(); }
  });
}

for (const locale of ["ko", "en"] as const) {
  test(`plain text citation gallery in ${locale} at 390px in dark @ui-state`, async ({ page }, info) => {
    await loadCatalog(locale); i18n.set(locale);
    await page.setViewportSize({ width: 390, height: 1000 });
    await page.addInitScript(value => {
      localStorage.setItem("console.locale", value);
      localStorage.setItem("console.theme", "dark");
    }, locale);
    const fixture = await mockScreen(page, screens[2], "populated");
    try {
      await page.goto("/_gallery?entry=payroll");
      const gallery = page.locator(".gallery__section").filter({ has: page.getByRole("heading", { name: t("payroll.reference.title"), exact: true }) });
      await gallery.scrollIntoViewIfNeeded();
      await expect(gallery.locator('a[href^="https:"]')).toHaveCount(0);
      await expect(gallery.getByRole("button", { name: t("uiField.copyUrl"), exact: true })).toHaveCount(0);
      await expect(gallery.getByText(/https:\/\/example.com\/payroll-source/)).toHaveCount(2);
      expect(await gallery.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      await gallery.screenshot({ path: info.outputPath("citation-gallery.png") });
      expect(fixture.unexpected).toEqual([]);
    } finally { await page.close(); fixture.release(); }
  });
}
