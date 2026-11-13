// SPDX-License-Identifier: LicenseRef-Proprietary
import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { fits } from "../a11y";
import { routeReady } from "../flows";
import { PORTS } from "../slot";
import { attendanceBoardScreens } from "../states/attendance";
import { mockScreen } from "./screen";

for (const [width, theme] of [[1440, "light"], [390, "dark"]] as const) {
  test(`attendance readiness waits for the lazy screen and primary read at ${width}px ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(value => localStorage.setItem("console.theme", value), theme);
    const screen = attendanceBoardScreens[0];
    const fixture = await mockScreen(page, screen, "loading");
    await page.addInitScript(() => {
      const fetch = window.fetch;
      const reads = { active: 0, started: false };
      Object.assign(window, { reads });
      window.fetch = async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        const tracked = new URL(request.url).pathname.startsWith("/api/") && !request.url.endsWith("/events");
        if (tracked) { reads.active++; reads.started = true; }
        try { return await fetch(input, init); }
        finally { if (tracked) reads.active--; }
      };
    });
    const manifest = JSON.parse(readFileSync(`.cache/states-${PORTS.web}/.vite/manifest.json`, "utf8")) as Record<string, { file: string }>;
    const entry = manifest["src/features/attendance/ui/attendance-page.tsx"];
    expect(entry).toBeDefined();
    const chunk = Promise.withResolvers<void>();
    await page.route(`**/${entry!.file}`, async route => { await chunk.promise; await route.continue(); });
    const requested = page.waitForRequest(`**/${entry!.file}`);
    try {
      await page.goto(screen.path);
      await requested;
      await page.waitForFunction(() => {
        const reads = (window as unknown as { reads: { active: number; started: boolean } }).reads;
        return reads.started && reads.active === 0;
      });
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      await expect(page.locator('main [data-read-layout="list"]:visible')).toBeVisible();
      await expect(page.locator("[data-route-ready]")).toHaveCount(0);
      const primary = page.waitForRequest(request => new URL(request.url()).pathname === screen.read);
      chunk.resolve();
      await primary;
      await expect(page.locator("[data-route-ready]")).toHaveCount(0);
      fixture.release();
      await routeReady(page);
      await expect(page.locator('main [aria-busy="true"]')).toHaveCount(0);
      await expect(page.locator("main h1")).toBeVisible();
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await fits(page, `attendance ${width}px ${theme}`);
      expect(fixture.unexpected).toEqual([]);
    } finally { chunk.resolve(); fixture.release(); }
  });
}
