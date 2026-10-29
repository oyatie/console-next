// SPDX-License-Identifier: LicenseRef-Proprietary
import { beforeAll, expect, test } from "vitest";
import { expect as element } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { authz, checklist } from "../../../../e2e/mock/fixtures";
import { navFixture } from "./nav.browser-fixture";

beforeAll(() => loadCatalog("ko"));

test("the receipt stays above the page, dismisses across reloads, and stays out of print with the skip link", async () => {
  const { server, browser, page } = await navFixture();
  const goLiveAt = new Date().toISOString();
  await page.route("**/api/v1/me/authz", route => route.fulfill({ json: authz }));
  await page.route("**/api/v1/onboarding/checklist", route => route.fulfill({ json: { ...checklist, go_live_at: goLiveAt } }));
  try {
    await page.goto(server.resolvedUrls!.local[0]!);
    const receipt = page.locator('[data-placement="page"]').filter({ hasText: t("setup.phase.started.title") });
    const assertPlacement = async () => {
      await element(receipt).toHaveCount(1);
      const band = await receipt.boundingBox();
      const head = await page.getByRole("heading", { name: "Setup", exact: true }).boundingBox();
      expect(band!.y + band!.height).toBeLessThanOrEqual(head!.y);
    };
    await assertPlacement();
    await page.reload();
    await assertPlacement();
    await page.emulateMedia({ media: "print" });
    await element(receipt).toBeHidden();
    await element(page.getByRole("link", { name: t("shell.skip"), includeHidden: true })).toBeHidden();
    await page.emulateMedia({ media: "screen" });
    await page.getByRole("button", { name: t("setup.phase.dismiss"), exact: true }).click();
    await element(receipt).toHaveCount(0);
    await page.reload();
    await element(page.getByRole("heading", { name: "Setup", exact: true })).toBeVisible();
    await element(receipt).toHaveCount(0);
    await page.evaluate(() => {
      for (const key of Object.keys(localStorage)) if (key.startsWith("console.phase.dismissed.")) {
        localStorage.setItem(`${key}.other`, localStorage.getItem(key)!);
        localStorage.removeItem(key);
      }
    });
    await page.reload();
    await assertPlacement();
  } finally { await browser.close(); await server.close(); }
}, 60_000);
