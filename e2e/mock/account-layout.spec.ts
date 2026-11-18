// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { fits } from "../a11y";
import { expectStable, recordShifts } from "../stability";
import { accountScreens } from "../states/account";
import { accountReads } from "./account";
import { advanceUntil } from "./clock";
import { failure } from "./fixtures";
import { mockScreen } from "./screen";

test.beforeAll(() => loadCatalog("ko"));

for (const read of ["/api/v1/auth/privacy-consent/status", "/api/v1/onboarding/terms"]) {
  for (const status of [200, 503]) for (const [width, theme] of [[1440, "light"], [390, "dark"]] as const) {
    test(`/account: late ${read} ${status} keeps following controls stable at ${width}px @ui-state`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript(recordShifts);
      const fixture = await mockScreen(page, accountScreens[0], "populated");
      await accountReads(page, "save-unchanged");
      const held = Promise.withResolvers<void>();
      const requested = Promise.withResolvers<void>();
      await page.route(url => url.pathname === read, async route => {
        requested.resolve();
        await held.promise;
        if (status === 503) await route.fulfill({ status, headers: { "Retry-After": "60" }, json: failure("service_unavailable") });
        else await route.fallback();
      });
      try {
        await page.goto("/account");
        await requested.promise;
        const main = page.getByRole("main");
        await expect(main.getByRole("heading", { level: 1 })).toBeVisible();
        const privacy = main.getByRole("link", { name: t("account.privacy.title"), exact: true });
        await expect(privacy).toBeVisible();
        await expect(main.getByRole("heading", { name: t("account.access.title"), exact: true })).toBeVisible();
        const consent = main.getByRole("region", { name: t("account.consent.title"), exact: true });
        await expect(consent.locator("dt")).toBeVisible();
        await expect(consent.locator("summary").last()).toBeVisible();
        const top = (await privacy.boundingBox())!.y;
        const answered = page.waitForResponse(response => new URL(response.url()).pathname === read);
        held.resolve();
        await (await answered).finished();
        await expect(privacy).toBeVisible();
        await expect(main.getByRole("heading", { name: t("account.access.title"), exact: true })).toBeVisible();
        if (status === 503 && read.endsWith("/status")) await expect(consent.locator("dd summary")).toHaveText(t("common.loadFailed.title"));
        if (status === 200) {
          if (read.endsWith("/status")) await expect(consent.locator("dd")).not.toHaveText(t("common.loading"));
          else await expect(consent.locator("summary").last()).toContainText("개인정보 처리 안내");
        }
        expect((await privacy.boundingBox())!.y).toBe(top);
        await expectStable(page, `account/${read}/${status}/${width}`);
        await page.locator("html").evaluate((el, value) => el.dataset.theme = value, theme);
        await fits(page, `account/${read}/${status}/${width}/${theme}`);
        await info.attach("settled", { body: await page.screenshot(), contentType: "image/png" });
        expect(fixture.unexpected).toEqual([]);
      } finally { held.resolve(); await page.close(); fixture.release(); }
    });
  }
}

for (const read of ["/api/v1/auth/privacy-consent/status", "/api/v1/onboarding/terms"]) {
  for (const retryAfter of [false, true]) test(`/account stays usable during ${read} backoff with Retry-After ${retryAfter} @ui-state`, async ({ page }) => {
    const fixture = await mockScreen(page, accountScreens[0], "populated");
    await accountReads(page, "save-unchanged");
    let calls = 0;
    await page.route(url => url.pathname === read, route => {
      calls++;
      return route.fulfill({ status: 503, headers: retryAfter ? { "Retry-After": "8" } : {}, json: failure("service_unavailable") });
    });
    const start = Date.now();
    await page.clock.install({ time: start });
    await page.clock.pauseAt(start + 60_000);
    try {
      const response = page.waitForResponse(reply => new URL(reply.url()).pathname === read);
      await page.goto("/account");
      const main = page.getByRole("main");
      await advanceUntil(page, response);
      await advanceUntil(page, main.getByRole("link", { name: t("account.privacy.title"), exact: true }).waitFor({ state: "visible" }));
      await expect(main.getByRole("heading", { name: t("account.access.title"), exact: true })).toBeVisible();
      expect(calls).toBe(1);
      expect(fixture.unexpected).toEqual([]);
    } finally { await page.close(); fixture.release(); }
  });
}
