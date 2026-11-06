// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { i18n, loadCatalog, t } from "@console/i18n";
import { expectAxe, fits } from "../a11y";
import { failure } from "../mock/fixtures";
import { mockRoute } from "../mock/route";
import { mockScreen } from "../mock/screen";
import { screens } from "./registry";

for (const locale of ["ko", "en"] as const) for (const state of ["populated", "empty", "loading", "failed"] as const) {
  test(`period unlock notices: ${state} in ${locale} at 390px in dark mode @ui-state`, async ({ page }) => {
    await loadCatalog(locale);
    i18n.set(locale);
    await page.addInitScript(value => localStorage.setItem("console.locale", value), locale);
    await page.setViewportSize({ width: 390, height: 844 });
    await mockScreen(page, screens[0], "empty");
    await mockRoute(page, "get", "/api/v1/reason-codes", request => ({ status: 200, json: { domain: new URL(request.url()).searchParams.get("domain") ?? "", items: [] } }));
    let release!: () => void;
    let reads = 0;
    let recovered = false;
    const held = new Promise<void>(resolve => { release = resolve; });
    await mockRoute(page, "get", "/api/v1/period-locks", async () => {
      reads++;
      if (state === "loading") await held;
      return state === "failed" && !recovered ? { status: 503, json: failure("service_unavailable") } : {
        status: 200, json: { items: [], soleHolderNotices: state === "empty" && !recovered ? 0 : 3 },
      };
    });
    await page.goto("/people/period-locks");
    await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
    await expect(page.getByRole("heading", { name: t("periodLocks.title"), exact: true })).toBeVisible();
    await expect.poll(() => reads).toBeGreaterThan(0);
    if (state === "loading") {
      await expect(page.getByRole("status", { name: t("common.loading") })).toBeVisible();
      await expect(page.getByRole("region", { name: t("periodLocks.new"), exact: true })).toHaveCount(0);
      release();
    }
    if (state === "failed") {
      const retry = page.getByRole("button", { name: t("common.retry") }).first();
      await expect(retry).toBeVisible({ timeout: test.info().timeout });
      recovered = true;
      await retry.click();
    } else if (state === "empty") {
      await expect(page.getByText(/단독 해제 알림|solo unlock notices/)).toHaveCount(0);
      recovered = true;
      await page.reload();
      await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
    }
    await expect(page.getByText(locale === "ko" ? "단독 해제 알림 3건" : "3 solo unlock notices", { exact: true })).toBeVisible();
    await fits(page, `period unlock notices/${state}`);
    await expectAxe(page, `period unlock notices/${state}`);
  });
}
