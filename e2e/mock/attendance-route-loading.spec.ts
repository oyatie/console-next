// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { fits } from "../a11y";
import { routeReady } from "../flows";
import { attendanceBoardScreens } from "../states/attendance";
import { checklist } from "./fixtures";
import { mockRoute } from "./route";
import { mockScreen } from "./screen";

test.beforeAll(() => loadCatalog("ko"));

test("attendance starts its phase read while its screen chunk is held", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  const fixture = await mockScreen(page, attendanceBoardScreens[0], "empty");
  const held = Promise.withResolvers<void>();
  const requested = Promise.withResolvers<void>();
  let reads = 0;
  await mockRoute(page, "get", "/api/v1/onboarding/checklist", () => {
    reads++;
    return { status: 200, json: checklist };
  });
  await page.route(/\/assets\/attendance-page-[^/]+\.js$/, async route => {
    requested.resolve();
    await held.promise;
    await route.continue();
  });
  try {
    await page.goto(attendanceBoardScreens[0].path, { waitUntil: "commit" });
    await requested.promise;
    await expect.poll(() => reads, { message: "the phase read must not wait for the attendance chunk" }).toBe(1);
    await expect(page.getByRole("button", { name: t("shell.menu"), exact: true })).toBeVisible();
    const loading = page.locator('main [data-read-layout="list"][aria-busy="true"]');
    await expect(loading).toBeVisible();
    for (const theme of ["light", "dark"]) {
      await page.locator("html").evaluate((element, value) => { element.dataset.theme = value; }, theme);
      await fits(page, `attendance/loading/${theme}`);
      await page.screenshot({ path: test.info().outputPath(`loading-${theme}.png`), fullPage: true });
    }
    held.resolve();
    await expect(page.getByRole("heading", { level: 1, name: t("attendance.title"), exact: true })).toBeVisible();
    await routeReady(page);
    expect(reads).toBe(1);
    await fits(page, "attendance/loaded");
    await page.reload();
    await expect(page.getByRole("heading", { level: 1, name: t("attendance.title"), exact: true })).toBeVisible();
    await routeReady(page);
    expect(reads).toBe(2);
    expect(fixture.unexpected).toEqual([]);
  } finally {
    held.resolve();
    await page.close();
    fixture.release();
  }
});
