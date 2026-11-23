// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { fits } from "../a11y";
import { attendanceBoardScreens } from "../states/attendance";
import { entityRecordPath, mockEntityRecord } from "../states/entity-record";
import { orgChangeScreens } from "../states/registry";
import { checklist } from "./fixtures";
import { mockRoute } from "./route";
import { mockScreen } from "./screen";
import { advanceUntil } from "./clock";

test.beforeAll(() => loadCatalog("ko"));

const surfaces = [
  { name: "month board", screen: attendanceBoardScreens.find(screen => screen.key === "attendance-month")! },
  { name: "day board", screen: attendanceBoardScreens.find(screen => screen.key === "attendance-day")! },
  { name: "flow record", screen: orgChangeScreens[1] },
  { name: "entity record", screen: null },
];

for (const surface of surfaces) for (const [width, colorScheme] of [[1440, "light"], [390, "dark"]] as const) {
  test(`the phase hold preserves the ${surface.name} without a settled layout box at ${width}px ${colorScheme}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme });
    const fixture = surface.screen
      ? await mockScreen(page, surface.screen, surface.name === "flow record" ? "approval" : "populated")
      : await mockEntityRecord(page, "populated");
    const held = Promise.withResolvers<void>();
    const requested = Promise.withResolvers<void>();
    await mockRoute(page, "get", "/api/v1/onboarding/checklist", async () => {
      requested.resolve();
      await held.promise;
      return { status: 200, json: checklist };
    });
    await page.clock.install();
    await page.clock.pauseAt(new Date());
    try {
      await page.goto(surface.screen?.path ?? entityRecordPath);
      const pending = page.locator("[data-phase-pending]");
      await advanceUntil(page, requested.promise);
      await expect(pending).toHaveCount(1);
      await expect(pending).toHaveAttribute("inert", "");
      await expect(pending).toHaveAttribute("aria-hidden", "true");
      await expect(pending).toHaveCSS("display", "block");
      await expect(pending).toHaveCSS("position", "absolute");
      await expect(pending).toHaveCSS("inset", "0px");
      await expect(pending).toHaveCSS("visibility", "hidden");
      await expect(page.getByRole("main").getByRole("status", { name: t("common.loading"), exact: true })).toHaveAttribute("aria-busy", "true");
      const wrapper = await pending.elementHandle();
      held.resolve();
      await page.clock.resume();
      await expect(page.getByRole("main").getByRole("heading", { level: 1 })).toBeVisible();
      await expect(pending).toHaveCount(0);
      expect(await wrapper!.evaluate(el => ({
        connected: el.isConnected, display: getComputedStyle(el).display,
        inert: el.hasAttribute("inert"), hidden: el.hasAttribute("aria-hidden"), boxes: el.getClientRects().length,
      }))).toEqual({ connected: true, display: "contents", inert: false, hidden: false, boxes: 0 });
      await fits(page, `phase layout/${surface.name}/${width}/${colorScheme}`);
      await info.attach("settled", { body: await page.screenshot(), contentType: "image/png" });
      expect(fixture.unexpected).toEqual([]);
    } finally { held.resolve(); await page.close(); fixture.release(); }
  });
}
