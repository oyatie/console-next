// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { i18n, loadCatalog } from "@console/i18n";
import { expectAxe, fits } from "../a11y";
import { failure, id, inbox } from "../mock/fixtures";
import { mockRoute } from "../mock/route";
import { mockScreen } from "../mock/screen";
import { screens } from "./registry";

test.afterEach(() => i18n.set("ko"));
for (const locale of ["ko", "en"] as const) for (const refused of [false, true]) {
  test(`solo unlock review ${locale} ${refused ? "refused" : "acknowledged"} @ui-state`, async ({ page }) => {
    await loadCatalog(locale);
    i18n.set(locale);
    await page.addInitScript(value => localStorage.setItem("console.locale", value), locale);
    await page.addInitScript(() => localStorage.setItem("console.theme", "dark"));
    await page.setViewportSize({ width: 390, height: 844 });
    await mockScreen(page, screens[0], "empty");
    const queue = inbox(1);
    const exception = id(902);
    const lock = id(900);
    queue.items[0] = { ...queue.items[0]!, due: "2026-10-29T09:00:00Z", id: `period_unlock:${exception}`, kind: "period_unlock", title: "해제 요청자",
      links: [{ kind: "period_lock", id: lock }],
      context: { unlock: { domain: "payroll", periodStart: "2026-06-01", periodEnd: "2026-06-30", requester: "해제 요청자", reason_code: "RETRO_CORRECTION", exceptionId: exception } } };
    let done = false;
    let posts = 0;
    await mockRoute(page, "get", "/api/v1/me/action-inbox", () => ({ status: 200, json: done ? inbox(0) : queue }));
    await page.route(`**/api/v1/period-locks/${lock}/unlock/reviews/${exception}/acknowledge`, route => {
      posts++;
      done = !refused;
      return route.fulfill({ status: refused ? 403 : 200, json: refused ? failure("forbidden") : { id: exception, status: "REVIEWED" } });
    });
    await page.goto("/inbox");
    const row = page.locator(`[data-id="period_unlock:${exception}"]`);
    await expect(row).toContainText(locale === "ko" ? "단독 해제 사후 검토" : "Sole-holder unlock review");
    const acknowledge = row.getByRole("button", { name: locale === "ko" ? "사후 검토 확인 기록" : "Acknowledge review", exact: true });
    await expect(acknowledge).toHaveCount(1);
    await fits(page, "solo unlock review at 390px dark");
    await expectAxe(page, "solo unlock review");
    await page.screenshot({ path: test.info().outputPath("review-dark-mobile.png"), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.evaluate(() => { localStorage.setItem("console.theme", "light"); });
    await page.reload();
    await expect(row).toBeVisible();
    await fits(page, "solo unlock review desktop");
    await expectAxe(page, "solo unlock review desktop");
    await page.screenshot({ path: test.info().outputPath("review-light-desktop.png"), fullPage: true });
    await acknowledge.click();
    await expect.poll(() => posts).toBe(1);
    if (refused) {
      await expect(row).toBeVisible();
      await expect(row.getByRole("alert")).toBeVisible();
    } else await expect(row).toBeHidden();

  });
}
