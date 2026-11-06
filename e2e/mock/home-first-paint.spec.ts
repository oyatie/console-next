// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { expectAxe, fits } from "../a11y";
import { inbox } from "./fixtures";
import { mockRoute } from "./route";
import { mockScreen } from "./screen";
import { screens } from "../states/registry";

test.beforeAll(() => loadCatalog("ko"));

for (const width of [1440, 390]) {
  test(`Home paints its arrival queue once and refreshes on return at ${width}px @ui-state`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    const fixture = await mockScreen(page, screens[0], "populated");
    let calls = 0;
    let arrival = 1;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    await mockRoute(page, "get", "/api/v1/me/action-inbox", async request => {
      const query = new URL(request.url()).searchParams;
      if (query.get("attention") === "all" && query.get("filter") === "turn") {
        calls++;
        if (calls > arrival) await held;
      }
      const queue = inbox(8);
      queue.items = queue.items.map(item => ({ ...item, title: `${item.title} · ${arrival}` }));
      return { status: 200, json: queue };
    });
    try {
      await page.goto("/");
      const preview = page.getByRole("region", { name: t("home.inbox.title"), exact: true });
      await expect(preview.locator("[data-id]")).toHaveCount(5);
      expect(calls, "the arrival read must not be repeated by the preview").toBe(1);
      for (const theme of ["light", "dark"]) {
        await page.locator("html").evaluate((el, value) => el.dataset.theme = value, theme);
        await fits(page, `Home first paint ${width}/${theme}`);
        await page.screenshot({ path: info.outputPath(`${theme}.png`), fullPage: true });
      }
      await expectAxe(page, `Home first paint ${width}`);
      await preview.getByRole("link", { name: t("home.inbox.viewInbox"), exact: true }).click();
      await expect(page).toHaveURL(/\/inbox$/);
      await expect(page.getByRole("heading", { level: 1, name: t("home.inbox.title"), exact: true })).toBeVisible();
      arrival++;
      await page.goBack();
      await expect(preview.locator("[data-id]")).toHaveCount(5);
      await expect(preview.locator("[data-id]").first()).toContainText("· 2");
      expect(calls, "returning Home still refreshes through its arrival gate").toBe(2);
      expect(fixture.unexpected).toEqual([]);
    } finally {
      await page.close();
      release();
      fixture.release();
    }
  });
}
