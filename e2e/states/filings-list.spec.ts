// SPDX-License-Identifier: LicenseRef-Proprietary
import { loadCatalog, t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { expect, test } from "@playwright/test";
import { expectAxe, fits } from "../a11y";
import { filingTask, mockFilings } from "../mock/filings";
import { id } from "../mock/fixtures";
import { mockScreen } from "../mock/screen";
import { screens } from "./registry";

test.beforeAll(() => loadCatalog("ko"));

for (const width of [1440, 390]) for (const theme of ["light", "dark"]) {
  test(`filing facts and actions reflow at ${width}px in ${theme} @ui-state`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.addInitScript(value => localStorage.setItem("console.theme", value), theme);
    const fixture = await mockScreen(page, screens[2], "populated");
    await mockFilings(page);
    try {
      await page.goto("/statutory");
      await expect(page.getByText(filingTask.name, { exact: true })).toBeVisible();
      await page.screenshot({ path: info.outputPath("filings.png"), fullPage: true });
      const grid = page.getByRole("grid", { name: t("statutory.insurance"), exact: true });
      await expect(grid).toHaveAttribute("data-layout", width === 390 ? "cards" : "rows");
      const row = grid.getByRole("row").filter({ hasText: filingTask.name });
      await expect(row.getByRole("link", { name: new RegExp(filingTask.name) })).toHaveAttribute("href", `/people/${id(100)}`);
      for (const value of [filingTask.employee_number!, filingTask.workplace_name!, t("statutory.NPS"), t("statutory.ACQUIRE"), fmtDate(filingTask.effective_date), t("statutory.days", { days: 3 })]) {
        await expect(row).toContainText(value);
      }
      await expect(row.getByRole("button", { name: t("statutory.record"), exact: true })).toBeVisible();
      const basis = row.getByText(t("statutory.basis"), { exact: true });
      await expect(row.getByText(t("statutory.hold"), { exact: true })).not.toBeVisible();
      await basis.click();
      await expect(row.getByText(t("statutory.hold"), { exact: true })).toHaveCount(1);
      await expect(row.getByText(t("statutory.hold"), { exact: true })).toBeVisible();
      await expect(row.getByRole("link", { name: /국민연금법/ })).toBeVisible();
      expect(await row.evaluate(element => {
        const bounds = element.getBoundingClientRect();
        return [...element.querySelectorAll("*")].filter(child => {
          const box = child.getBoundingClientRect();
          return box.width > 1 && (box.right > bounds.right + 1 || box.left < bounds.left - 1);
        }).length;
      })).toBe(0);
      await fits(page, `filings ${width} ${theme}`);
      await expectAxe(page, `filings ${width} ${theme}`);
      await basis.click();
      await row.getByRole("button", { name: t("statutory.record"), exact: true }).click();
      const dialog = page.getByRole("dialog", { name: t("statutory.completeTitle", { name: filingTask.name, insurer: t("statutory.NPS"), kind: t("statutory.ACQUIRE") }) });
      await expect(dialog.getByRole("button", { name: t("statutory.preview"), exact: true })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await page.getByRole("button", { name: t("statutory.done"), exact: true }).click();
      await expect(grid).toContainText("RECEIPT-001");
      await expect(grid.getByRole("button", { name: t("statutory.undo"), exact: true })).toBeVisible();
      await fits(page, `filings completed ${width} ${theme}`);
      await expectAxe(page, `filings completed ${width} ${theme}`);
      expect(fixture.unexpected).toEqual([]);
    } finally { await page.close(); fixture.release(); }
  });
}

test("filing search keeps the server filter and clears it on reset @ui-state", async ({ page }) => {
  const fixture = await mockScreen(page, screens[2], "populated");
  const queries = await mockFilings(page);
  try {
    await page.goto("/statutory");
    const search = page.getByRole("searchbox", { name: t("statutory.search") });
    await search.fill("없는 직원");
    await search.press("Enter");
    await expect(page.getByRole("heading", { name: t("statutory.empty"), exact: true })).toBeVisible();
    expect(queries.some(query => query.get("search") === "없는 직원")).toBe(true);
    await search.fill("");
    await search.press("Enter");
    await expect(page.getByRole("grid", { name: t("statutory.insurance"), exact: true })).toContainText(filingTask.name);
    await page.goto("/_gallery");
    const gallery = page.locator("#gallery-filings");
    await gallery.scrollIntoViewIfNeeded();
    await expect(gallery.getByRole("grid", { name: t("statutory.insurance"), exact: true })).toBeVisible();
    await gallery.getByRole("button", { name: t("statutory.record"), exact: true }).click();
    await expect(gallery.getByRole("status")).toHaveText(t("statutory.record"));
    expect(fixture.unexpected).toEqual([]);
  } finally { await page.close(); fixture.release(); }
});
