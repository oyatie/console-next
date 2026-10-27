// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";

for (const width of [390, 1280, 1440, 1920]) for (const theme of ["light", "dark"]) {
  test(`table contract at ${width}px in ${theme}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: width === 1280 ? 720 : 1080 });
    await page.addInitScript(value => localStorage.setItem("console.theme", value), theme);
    // Other gallery entries may read access facts; no live API participates in this component proof.
    await page.route("**/api/**", route => route.fulfill({ status: 403, json: { error: { code: "forbidden", message: "" } } }));
    await page.goto("/_gallery");
    // The lazy gallery route must mount before the table assertions use their own budget.
    await expect(page.getByRole("heading", { name: "컴포넌트 갤러리", level: 1, includeHidden: true })).toBeVisible({ timeout: 15_000 });
    if (width === 390) {
      await expect(page.getByRole("dialog")).toBeVisible();
      await page.getByRole("dialog").getByRole("button", { name: "닫기", exact: true }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
    }
    const state = (name: string) => page.locator(`[data-column-contract="${name}"]`);
    const populated = state("populated");
    const table = populated.getByRole("grid");
    await expect(table).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await expect(table.locator("caption")).toHaveText("직원 목록(1행)");
    await expect(table).not.toHaveAttribute("aria-label");
    await expect(table.locator("colgroup col")).toHaveCount(10);
    await expect(table).toHaveAttribute("data-density", "compact");
    const rect = await table.boundingBox();
    expect(rect!.x).toBeGreaterThanOrEqual(0);
    expect(rect!.x + rect!.width).toBeLessThanOrEqual(width);
    if (width > 390) {
      await expect(populated.getByRole("columnheader", { name: "인원", exact: true })).toHaveCSS("text-align", "end");
      await expect(table.locator('td[data-type="money"]')).toHaveCSS("font-variant-numeric", "tabular-nums");
      await expect(table.locator('td[data-type="code"]')).toHaveCSS("text-align", "start");
      const height = await table.locator("tbody tr").first().evaluate(el => el.getBoundingClientRect().height);
      expect(height).toBeGreaterThanOrEqual(32);
      expect(height).toBeLessThanOrEqual(33);
      const name = table.locator('td[data-type="text"]');
      await expect(name).toHaveAttribute("title", await name.innerText());
    }
    const action = populated.getByRole("button", { name: "열기", exact: true });
    await action.click();
    await expect(table.locator('tr[aria-selected="true"]')).toHaveCount(1);
    const large = state("large").getByRole("grid");
    await expect(large).toBeVisible();
    await expect(large).toHaveAttribute("data-total", "2000");
    await expect(large).toHaveAttribute("aria-rowcount", "2001");
    if (width > 390) for (const grid of [table, large]) {
      const percent = grid.getByRole("columnheader", { name: "비율 (%)", exact: true });
      await expect(percent).toBeVisible();
      const fits = await percent.evaluate(el => {
        const text = document.createRange();
        text.selectNodeContents(el);
        const label = text.getBoundingClientRect();
        const cell = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return label.left >= cell.left + parseFloat(style.paddingLeft) - 1
          && label.right <= cell.right - parseFloat(style.paddingRight) + 1
          && label.top >= cell.top && label.bottom <= cell.bottom;
      });
      expect(fits, "percentage header fits without clipping").toBe(true);
    }
    const visibleRows = large.locator('[role="row"][data-key]:visible');
    await expect(visibleRows.first()).toBeVisible();
    expect(await visibleRows.count()).toBeGreaterThan(1);
    expect(await visibleRows.count()).toBeLessThanOrEqual(40);
    await expect(visibleRows.first()).toHaveAttribute("aria-rowindex", "2");
    await expect(state("loading").getByRole("status")).toHaveText("불러오는 중");
    for (const name of ["empty", "failed", "refused"]) {
      await expect(state(name).getByRole("grid")).toHaveCount(0);
      await expect(state(name).locator("table")).toHaveCount(0);
    }
    await expect(state("failed").getByRole("alert")).toContainText("op_gallery_columns");
    await expect(state("stale").getByRole("grid")).toBeVisible();
    await expect(state("stale")).toContainText("op_gallery_columns");
    await expect(state("refused")).toContainText("op_gallery_columns");
    await expect(state("refused").getByRole("button", { name: "열기", exact: true })).toHaveCount(0);
    for (const name of ["empty", "failed"]) {
      const region = await state(name).boundingBox();
      const message = await state(name).getByRole("heading").first().boundingBox();
      expect(message!.y - region!.y).toBeLessThanOrEqual(24);
      expect(message!.x - region!.x).toBeLessThanOrEqual(24);
    }
    await populated.screenshot({ path: testInfo.outputPath(`columns-${width}-${theme}.png`) });
    for (const name of ["failed", "stale"]) {
      await state(name).getByRole("button", { name: "다시 불러오기", exact: true }).click();
      await expect(state(name).getByRole("grid")).toBeVisible();
      await expect(state(name).getByRole("button", { name: "다시 불러오기", exact: true })).toHaveCount(0);
      await expect(state(name)).not.toContainText("op_gallery_columns");
    }
  });
}
