// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { fits } from "../a11y";
import { todayKst } from "../../apps/web/src/lib/pure/today";
import { routeReady } from "../flows";
import { attendanceBoardScreens } from "../states/attendance";
import { checklist, id } from "./fixtures";
import { mockRoute } from "./route";
import { mockScreen } from "./screen";
import { holdChunks } from "./chunk-probe";

test.beforeAll(() => loadCatalog("ko"));

test("attendance starts its phase read while its screen chunk is held", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  const fixture = await mockScreen(page, attendanceBoardScreens[0], "empty");
  const chunks = await holdChunks(page, ["src/features/attendance/ui/attendance-page.tsx"]);
  let reads = 0;
  await mockRoute(page, "get", "/api/v1/onboarding/checklist", () => {
    reads++;
    return { status: 200, json: checklist };
  });
  try {
    await page.goto(attendanceBoardScreens[0].path, { waitUntil: "commit" });
    await chunks.requested;
    await expect.poll(() => reads, { message: "the phase read must not wait for the attendance chunk" }).toBe(1);
    await expect(page.getByRole("button", { name: t("shell.menu"), exact: true })).toBeVisible();
    const loading = page.locator('main [data-read-layout="list"][aria-busy="true"]');
    await expect(loading).toBeVisible();
    for (const theme of ["light", "dark"]) {
      await page.locator("html").evaluate((element, value) => { element.dataset.theme = value; }, theme);
      await fits(page, `attendance/loading/${theme}`);
      await page.screenshot({ path: test.info().outputPath(`loading-${theme}.png`), fullPage: true });
    }
    chunks.release();
    await expect(page.getByRole("heading", { level: 1, name: t("attendance.title"), exact: true })).toBeVisible();
    await routeReady(page);
    expect(reads).toBe(1);
    for (const theme of ["light", "dark"]) {
      await page.locator("html").evaluate((element, value) => { element.dataset.theme = value; }, theme);
      await fits(page, `attendance/loaded/${theme}`);
      await page.screenshot({ path: test.info().outputPath(`loaded-${theme}.png`), fullPage: true });
    }
    await page.reload();
    await expect(page.getByRole("heading", { level: 1, name: t("attendance.title"), exact: true })).toBeVisible();
    await routeReady(page);
    expect(reads).toBe(2);
    expect(fixture.unexpected).toEqual([]);
  } finally {
    chunks.release();
    await page.close();
    fixture.release();
  }
});

for (const search of [undefined, "", `&wp=${id(4)}&unit=${id(5)}`]) {
  test(`the month read stays behind the attendance chunk and runs once on mount ${search ?? "default"}`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    const fixture = await mockScreen(page, attendanceBoardScreens[0], "empty");
    const held = Promise.withResolvers<void>();
    const requested = Promise.withResolvers<void>();
    const reads: URL[] = [];
    page.on("request", request => {
      const url = new URL(request.url());
      if (url.pathname === "/api/v1/attendance/month") reads.push(url);
    });
    await page.route(/\/assets\/attendance-page-[^/]+\.js$/, async route => {
      requested.resolve();
      await held.promise;
      await route.continue();
    });
    try {
      await page.goto(search === undefined ? "/attendance" : `${attendanceBoardScreens[0].path}${search}`, { waitUntil: "commit" });
      await requested.promise;
      await expect(page.getByRole("button", { name: t("shell.menu"), exact: true })).toBeVisible();
      expect(reads, "the month read belongs to the lazy attendance screen").toHaveLength(0);
      held.resolve();
      await routeReady(page);
      expect(reads).toHaveLength(1);
      expect(reads[0]!.searchParams.get("month")).toBe(search === undefined ? todayKst().slice(0, 7) : "2026-10");
      expect(reads[0]!.searchParams.get("workplace_id")).toBe(search ? id(4) : null);
      expect(reads[0]!.searchParams.get("unit_id")).toBe(search ? id(5) : null);
      expect(fixture.unexpected).toEqual([]);
    } finally {
      held.resolve();
      await page.close();
      fixture.release();
    }
  });
}

for (const screen of attendanceBoardScreens.slice(1)) {
  test(`${screen.key} leaves the monthly read idle`, async ({ page }) => {
    const fixture = await mockScreen(page, screen, "empty");
    const reads: string[] = [];
    page.on("request", request => {
      if (new URL(request.url()).pathname === "/api/v1/attendance/month") reads.push(request.url());
    });
    try {
      await page.goto(screen.path);
      await routeReady(page);
      expect(reads).toEqual([]);
      expect(fixture.unexpected).toEqual([]);
    } finally {
      await page.close();
      fixture.release();
    }
  });
}
