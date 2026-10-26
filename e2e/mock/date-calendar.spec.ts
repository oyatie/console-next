// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { mockScreen } from "./screen";
import { screens } from "../states/registry";

test.beforeAll(() => loadCatalog("ko"));

for (const intent of ["hover", "focus"] as const) {
  test(`date calendar loads on ${intent}; typing works while its chunk is held`, async ({ page }) => {
    const fixture = await mockScreen(page, screens[1], "empty");
    let requests = 0;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    await page.route("**/ui/date/date-calendar.tsx*", async route => {
      requests++;
      await held;
      await route.continue();
    });
    try {
      await page.goto("/_gallery");
      const demo = page.locator("section").filter({ has: page.getByRole("heading", { name: "날짜 필드", exact: true }) });
      const input = demo.getByRole("textbox").first();
      const trigger = demo.getByRole("button", { name: t("uiDate.calendar.open"), exact: true }).first();
      await expect(input).toBeVisible();
      expect(requests).toBe(0);
      await trigger[intent]();
      await expect.poll(() => requests).toBe(1);
      const calendar = page.getByRole("dialog", { name: t("uiDate.calendar.label"), exact: true });
      await expect(calendar).toHaveCount(0);
      await input.fill("20261115");
      await input.press("Tab");
      await expect(input).toHaveValue("2026. 11. 15.");
      await trigger.press("Enter");
      await expect(calendar).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(calendar).toHaveCount(0);
      const delivered = page.waitForResponse("**/ui/date/date-calendar.tsx*");
      release();
      await delivered;
      await expect(calendar).toHaveCount(0);
      await trigger.press("Enter");
      await expect(calendar).toBeVisible();
      await expect(calendar.getByRole("button", { name: /2026년 11월 15일/ })).toBeFocused();
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("Enter");
      await expect(calendar).toHaveCount(0);
      await expect(input).toHaveValue("2026. 11. 16.");
      await expect(trigger).toBeFocused();
      await trigger.press("Enter");
      await expect(calendar).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(calendar).toHaveCount(0);
      await expect(trigger).toBeFocused();
      expect(requests).toBe(1);
    } finally {
      release();
      fixture.release();
      await page.close();
    }
  });
}
