// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { i18n, loadCatalog, t } from "@console/i18n";
import { expectAxe, fits } from "../a11y";
import { failure, id, inbox } from "../mock/fixtures";
import { mockRoute } from "../mock/route";
import { mockScreen } from "../mock/screen";
import { screens } from "./registry";

for (const locale of ["ko", "en"] as const) for (const state of ["populated", "empty", "loading", "failed"] as const) {
  test(`period unlock inbox: ${state} in ${locale} at 390px in dark mode @ui-state`, async ({ page }) => {
    await loadCatalog(locale);
    i18n.set(locale);
    await page.addInitScript(value => localStorage.setItem("console.locale", value), locale);
    await page.addInitScript(() => localStorage.setItem("console.theme", "dark"));
    await page.setViewportSize({ width: 390, height: 844 });
    await mockScreen(page, screens[0], "empty");
    await mockRoute(page, "get", "/api/v1/reason-codes", request => ({ status: 200, json: { domain: new URL(request.url()).searchParams.get("domain") ?? "", items: [] } }));
    let release!: () => void;
    let reads = 0;
    let recovered = false;
    const held = new Promise<void>(resolve => { release = resolve; });
    // A cached response from the retired count contract must not restore a second task surface.
    const legacyLocks = { items: [], soleHolderNotices: 3 };
    await mockRoute(page, "get", "/api/v1/period-locks", async () => {
      reads++;
      if (state === "loading") await held;
      return state === "failed" && !recovered ? { status: 503, json: failure("service_unavailable") } : {
        status: 200, json: legacyLocks,
      };
    });
    await page.goto("/people/period-locks");
    await expect(page.getByRole("heading", { name: t("periodLocks.title"), exact: true })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
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
    }
    const unlocked = page.getByRole("button", { name: t("periodLocks.view.unlocked", { count: 0 }) });
    await expect(unlocked).toBeVisible();
    await expect(unlocked.locator(".chip--warn")).toHaveCount(0);
    await unlocked.click();
    await expect(unlocked).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("heading", { name: t("periodLocks.unlocked.section", { count: 0 }), exact: true })).toBeVisible();
    await fits(page, `period locks/${state}`);
    await expectAxe(page, `period locks/${state}`);
    await page.screenshot({ path: test.info().outputPath("period-locks.png"), fullPage: true });
    const data = inbox(1);
    data.items[0] = { ...data.items[0]!, id: `period_unlock:${id(901)}`, kind: "period_unlock",
      title: "해제 요청자", links: [{ kind: "period_lock", id: id(900) }],
      context: { unlock: { domain: "payroll", periodStart: "2026-06-01", periodEnd: "2026-06-30", requester: "해제 요청자", reason_code: "RETRO_CORRECTION" } } };
    await mockRoute(page, "get", "/api/v1/me/action-inbox", { status: 200, json: data });
    await page.goto("/inbox");
    const item = page.locator(`[data-id="${data.items[0]!.id}"]`);
    await expect(item).toContainText("해제 요청자");
    await expect(item.getByRole("link").first()).toHaveAttribute("href", `/people/period-locks?review=${id(900)}`);
    await fits(page, `period unlock inbox/${state}`);
    await expectAxe(page, `period unlock inbox/${state}`);
    await page.screenshot({ path: test.info().outputPath("inbox.png"), fullPage: true });
  });
}
