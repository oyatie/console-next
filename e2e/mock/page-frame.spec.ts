// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { loadCatalog, t } from "@console/i18n";
import { tg } from "@console/i18n/gallery";
import { mockRoute } from "./route";
import { screenAccess } from "./fixtures";
import { breakpoints, mediaQueries } from "../../apps/web/src/ui/breakpoints";

test.beforeAll(() => loadCatalog("ko"));

for (const width of [1440, 1024, 390, 320]) for (const theme of ["light", "dark"]) {
  test(`page contract in the gallery at ${width}px in ${theme}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 1000 });
    await mockRoute(page, "get", "/api/v1/access/granters", { status: 200, json: { count: 0, names: [] } });
    await mockRoute(page, "get", "/api/v1/access/me", { status: 200, json: screenAccess("/_gallery") });
    await page.addInitScript(value => localStorage.setItem("console.theme", value), theme);
    await page.goto("/_gallery");
    if (width === 320) await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    expect(await page.evaluate(query => matchMedia(query).matches, mediaQueries.phone)).toBe(width < breakpoints.md);
    // Another gallery demo opens its dock sheet automatically at phone widths.
    if (width < breakpoints.md) {
      await expect(page.getByRole("dialog")).toBeVisible();
      await page.keyboard.press("Escape");
    }
    const demo = page.locator("[data-page-gallery]");
    await expect(demo).toBeVisible();
    const states = demo.getByRole("group", { name: tg("section.states"), exact: true }).getByRole("button");
    const frame = demo.locator('[data-floorplan="list"]');
    await expect(frame.locator('[data-list-region="body"]')).toBeVisible();
    for (let i = 0; i < 7; i++) {
      await states.nth(i).click();
      await expect(frame.getByRole("heading", { level: 2 }).first()).toBeVisible();
      await expect(frame.locator("h1, main")).toHaveCount(0);
      if (i === 0) await expect(frame.getByRole("status", { name: t("common.loading"), exact: true })).toBeVisible();
      if (i === 1) {
        await expect(frame.getByText(tg("empty.title"), { exact: true })).toBeVisible();
        const primary = frame.getByRole("button", { name: tg("pageHead.add"), exact: true });
        await primary.click();
        await expect(page.getByRole("dialog", { name: tg("sheet.title"), exact: true })).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(primary).toBeFocused();
      }
      if (i === 2) {
        await expect(frame.getByRole("alert")).toHaveCount(1);
        await expect(frame.getByText("gallery-page-read", { exact: true })).toBeVisible();
        await frame.getByRole("button", { name: t("common.retry"), exact: true }).click();
        await expect(frame.getByRole("grid")).toBeVisible();
      }
      if (i === 3) {
        await expect(frame.getByRole("grid")).toHaveCount(0);
        await expect(frame.getByRole("button", { name: tg("pageHead.add"), exact: true })).toHaveCount(0);
        await frame.getByText(t("common.denied.why"), { exact: true }).click();
        await expect(frame.getByText("gallery-page-refusal", { exact: true })).toBeVisible();
      }
      if (i === 6) {
        await expect(frame.getByRole("rowheader").first()).toBeVisible();
        expect(await frame.getByRole("rowheader").count()).toBeLessThanOrEqual(50);
        await expect(frame.getByRole("grid")).toHaveAttribute("aria-rowcount", "2001");
        await expect(frame.locator("header")).toContainText("2,000");
      }
      expect(await frame.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    }
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    const { violations } = await new AxeBuilder({ page }).include("[data-page-gallery]").withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    expect(violations).toEqual([]);
    await info.attach("list-template", { body: await frame.screenshot(), contentType: "image/png" });
    const primary = frame.getByRole("button", { name: tg("pageHead.add"), exact: true });
    if (width < breakpoints.md) {
      const more = frame.getByRole("button", { name: t("uiRecordActions.more", { field: tg("pageHead.list") }), exact: true });
      await more.focus();
      await more.press("Enter");
      const exportAction = page.getByRole("menuitem", { name: tg("pageHead.export"), exact: true });
      await expect(exportAction).toBeFocused();
      await exportAction.press("Enter");
      await expect(frame.getByRole("status")).toHaveText(tg("pageHead.exported"));
    } else {
      await frame.getByRole("button", { name: tg("pageHead.export"), exact: true }).click();
      await expect(frame.getByRole("status")).toHaveText(tg("pageHead.exported"));
    }
    await expect(demo.getByText(tg("state.loaded"), { exact: true })).toHaveCount(0);
    await primary.click();
    const sheet = page.getByRole("dialog", { name: tg("sheet.title"), exact: true });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole("heading", { level: 2, name: tg("sheet.subtitle"), exact: true })).toBeVisible();
    await expect(page.locator("main")).toHaveCount(1);
    await expect(sheet.locator("h1, main")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(primary).toBeFocused();
  });
}
