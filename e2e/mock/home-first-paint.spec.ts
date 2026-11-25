// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test, type Page } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { expectAxe, fits } from "../a11y";
import { experienceState } from "../experience";
import { inbox } from "./fixtures";
import { mockRoute } from "./route";
import { mockScreen } from "./screen";
import { screens } from "../states/registry";

test.beforeAll(() => loadCatalog("ko"));

/** The queue's rows: Classic's queue card, or Console's worklist grid (its deadline strip repeats the same ids). */
const queueRows = (page: Page) => page.getByRole("region", { name: t("home.inbox.title"), exact: true }).locator("[data-id]")
  .or(page.getByRole("grid", { name: t("home.inbox.title"), exact: true }).locator("[data-id]"));

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
      // How many rows Home previews is each style's own (pinned below).
      await expect(queueRows(page).first()).toBeVisible();
      expect(calls, "the arrival read must not be repeated by the preview").toBe(1);
      for (const theme of ["light", "dark"]) {
        await page.locator("html").evaluate((el, value) => el.dataset.theme = value, theme);
        await fits(page, `Home first paint ${width}/${theme}`);
        await page.screenshot({ path: info.outputPath(`${theme}.png`), fullPage: true });
      }
      await expectAxe(page, `Home first paint ${width}`);
      await page.getByRole("main").getByRole("link", { name: t("home.inbox.viewInbox"), exact: true }).click();
      await expect(page).toHaveURL(/\/inbox$/);
      await expect(page.getByRole("heading", { level: 1, name: t("home.inbox.title"), exact: true })).toBeVisible();
      arrival++;
      await page.goBack();
      await expect(queueRows(page).first()).toContainText("· 2");
      expect(calls, "returning Home still refreshes through its arrival gate").toBe(2);
      expect(fixture.unexpected).toEqual([]);
    } finally {
      await page.close();
      release();
      fixture.release();
    }
  });
}

// Home previews the queue's first rows: five in Classic; up to ten in Console (HOME_CONSOLE_ROWS), which no board fixes,
// so the Console value is the render's.
async function openHome(page: Page) {
  await mockScreen(page, screens[0], "populated");
  await mockRoute(page, "get", "/api/v1/me/action-inbox", { status: 200, json: inbox(12) });
  await page.goto("/");
}

test("Classic Home's first paint previews five queue rows", { tag: "@baseline" }, async ({ page }) => {
  await openHome(page);
  await expect(page.getByRole("region", { name: t("home.inbox.title"), exact: true }).locator("[data-id]")).toHaveCount(5);
});

test.describe("console look", () => {
  test.use({ storageState: experienceState("console") });
  test("Console Home's first paint lists ten queue rows", async ({ page }) => {
    await openHome(page);
    await expect(page.getByRole("grid", { name: t("home.inbox.title"), exact: true }).locator("[data-id]")).toHaveCount(10);
  });
});
