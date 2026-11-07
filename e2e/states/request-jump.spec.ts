// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { expectAxe, fits } from "../a11y";
import { AT, failure, id } from "../mock/fixtures";
import { mockRoute } from "../mock/route";
import { mockScreen } from "../mock/screen";
import { screens } from "./registry";

test.beforeAll(() => loadCatalog("ko"));

for (const width of [1440, 390]) for (const theme of ["light", "dark"]) for (const missing of [false, true]) {
  test(`Home request key lookup ${missing ? "not found" : "refused"} by keyboard at ${width}px ${theme} @ui-state`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(value => localStorage.setItem("console.theme", value), theme);
    const fixture = await mockScreen(page, screens[0], "empty");
    let reads = 0;
    const key = missing ? "request/with?reserved#characters" : id(99);
    await mockRoute(page, "get", "/api/v1/requests/{key}", () => {
      reads++;
      return missing ? { status: 404, json: failure("request_not_found") } : { status: 200, json: {
        id: id(99), idempotency_key: id(99), command: "POST /api/v1/change-requests/{id}/decide",
        state: "REFUSED" as const, created_at: AT, deadline: null, settled_at: AT, inputs_masked: {}, result: null,
        refusal_code: "change_request_not_assignee", masked: false, touched: [],
      } };
    });
    try {
      await page.goto("/");
      await expect(page.getByRole("heading", { name: t("home.noWork.title"), exact: true })).toBeVisible();
      await page.keyboard.press("Control+KeyK");
      const palette = page.getByRole("dialog", { name: t("shell.jumpLabel"), exact: true });
      const input = palette.getByRole("searchbox");
      await input.fill(`  ${key}  `);
      const result = palette.getByRole("menuitem", { name: t("requestOutcome.find"), exact: true });
      await expect(result).toBeVisible();
      expect(reads, "a pasted key must not be looked up until selected").toBe(0);
      await fits(page, `request jump/${width}/${theme}`);
      await page.screenshot({ path: info.outputPath(`${missing ? "missing" : "refused"}.png`), fullPage: true });
      await expectAxe(page, `request jump/${width}/${theme}`);
      await result.press("Enter");
      await expect(palette).toHaveCount(0);
      await expect(page).toHaveURL(new RegExp(`/requests/${encodeURIComponent(key).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
      if (missing) {
        await expect(page.getByRole("main").first()).toContainText(t("requestOutcome.notFound"));
      } else {
        await expect(page.getByRole("main").first()).toContainText(t("common.failed.code.change_request_not_assignee"));
      }
      await fits(page, `request resolver/${width}/${theme}`);
      await page.screenshot({ path: info.outputPath("outcome.png"), fullPage: true });
      await expectAxe(page, `request resolver/${width}/${theme}`);
      expect(reads).toBe(1);
      expect(fixture.unexpected).toEqual([]);
    } finally { await page.close(); fixture.release(); }
  });
}
