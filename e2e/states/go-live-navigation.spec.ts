// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect } from "@playwright/test";
import { test } from "../locale-fixture";
import { t } from "@console/i18n";
import { fits } from "../a11y";
import { id, screenAccess, user } from "../mock/fixtures";
import { previewData } from "../mock/onboarding";
import { mockRoute } from "../mock/route";
import { mockScreen } from "../mock/screen";
import { homeSetupChecklist, homeSetupScreen } from "./home-setup";
import { openNav } from "../shell";

for (const leave of [false, true]) test(`go-live readiness ${leave ? "respects a rail click" : "keeps launch busy"} @ui-state`, async ({ page }) => {
  const fixture = await mockScreen(page, homeSetupScreen, "empty");
  const held = Promise.withResolvers<void>();
  let applied = false;
  const requested = Promise.withResolvers<void>();
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await mockRoute(page, "get", "/api/v1/users/me", () => ({ status: 200, json: {
    ...user, is_tenant_ops: true, tenant: { name: "Screen Test Company", phase: applied ? "OPERATING" : "SETUP", go_live_at: applied ? "2026-10-26T09:00:00Z" : null },
  } }));
  await mockRoute(page, "get", "/api/v1/access/me", async () => {
    if (applied) { requested.resolve(); await held.promise; }
    return { status: 200, json: { ...screenAccess("/org", applied ? "OPERATING" : "SETUP"), is_ops: true } };
  });
  await mockRoute(page, "get", "/api/v1/onboarding/checklist", { status: 200, json: homeSetupChecklist("ready") });
  await mockRoute(page, "get", "/api/v1/onboarding/go-live/preview", { status: 200, json: previewData("ready") });
  await mockRoute(page, "post", "/api/v1/auth/passkey/login/start", { status: 200, json: {
    ceremony_id: id(600), expires_at: "2099-01-01T00:00:00Z", challenge: { publicKey: { challenge: "AQID", rpId: "localhost" } },
  } });
  await page.addInitScript(() => Object.defineProperty(navigator.credentials, "get", {
    value: async () => ({ toJSON: () => ({ id: "test-passkey", type: "public-key" }) }),
  }));
  await mockRoute(page, "post", "/api/v1/onboarding/go-live", () => {
    applied = true;
    return { status: 200, json: { phase: "OPERATING" as const, go_live_at: "2026-10-26T09:00:00Z", notified: 1 } };
  });
  try {
    await page.goto("/setup/go-live");
    const main = page.getByRole("main");
    const start = main.getByRole("button", { name: t("setup.golive.start"), exact: true });
    await main.getByRole("checkbox", { name: t("setup.golive.soleHolder"), exact: true }).check();
    await start.click();
    await requested.promise;
    await expect(start).toBeDisabled();
    await expect(start).toHaveCount(1);
    await page.setViewportSize({ width: 390, height: 900 });
    await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
    await fits(page, "go-live/readiness/390/dark");
    if (leave) {
      await (await openNav(page)).getByRole("link", { name: t("shell.link.org"), exact: true }).click();
      await expect(page).toHaveURL(/\/org$/);
    }
    const refreshed = page.waitForResponse("**/api/v1/access/me");
    held.resolve();
    await (await refreshed).finished();
    // The command and its navigation callback finish before the next browser task.
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)));
    await expect(page).toHaveURL(leave ? /\/org$/ : /\/$/);
    expect(errors).toEqual([]);
    expect(fixture.unexpected).toEqual([]);
  } finally { await page.close(); held.resolve(); fixture.release(); }
});
