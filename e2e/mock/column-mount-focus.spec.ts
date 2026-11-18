// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { fits } from "../a11y";
import { screens } from "../states/registry";
import { advanceUntil } from "./clock";
import { checklist, inbox } from "./fixtures";
import { mockRoute } from "./route";
import { mockScreen } from "./screen";

test.beforeAll(() => loadCatalog("ko"));

for (const path of ["/", "/inbox"]) test(`the selected column on ${path} takes focus after the page is revealed @ui-state`, async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  const fixture = await mockScreen(page, screens[0], "populated");
  const held = Promise.withResolvers<void>();
  await mockRoute(page, "get", "/api/v1/onboarding/checklist", async () => {
    await held.promise;
    return { status: 200, json: checklist };
  });
  await page.addInitScript(() => {
    const focus = HTMLElement.prototype.focus;
    HTMLElement.prototype.focus = function(options) {
      if (this.closest("[data-phase-pending] [data-flexible-columns] aside")) this.dataset.focusedWhileHeld = "";
      focus.call(this, options);
    };
  });
  const start = Date.now();
  await page.clock.install({ time: start });
  await page.clock.pauseAt(start + 60_000);
  try {
    const id = inbox(fixture.count).items[0]!.id;
    await page.goto(`${path}?${path === "/inbox" ? "tab=turn&" : ""}sel=${encodeURIComponent(id)}`);
    await advanceUntil(page, page.locator("[data-phase-pending] [data-flexible-columns] aside").waitFor({ state: "attached" }));
    await page.clock.runFor(32);
    await expect(page.locator("[data-focused-while-held]")).toHaveCount(0);
    held.resolve();
    await page.clock.resume();
    const pane = page.getByRole("complementary", { name: t("home.inbox.record.title"), exact: true });
    await expect(pane.getByRole("button", { name: t("common.back"), exact: true })).toBeFocused();
    await page.locator("html").evaluate(el => el.dataset.theme = "dark");
    await fits(page, path);
    await page.keyboard.press("Escape");
    await expect(pane).toHaveCount(0);
    await expect(page).not.toHaveURL(/sel=/);
    await expect(page.locator(`main [data-id="${id}"]`)).toBeFocused();
    expect(fixture.unexpected).toEqual([]);
  } finally { held.resolve(); await page.close(); fixture.release(); }
});

test("cold registration focuses the name cell after the held page opens @ui-state", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => localStorage.setItem("console.theme", "dark"));
  const fixture = await mockScreen(page, screens[1], "populated");
  const held = Promise.withResolvers<void>();
  await mockRoute(page, "get", "/api/v1/onboarding/checklist", async () => {
    await held.promise;
    return { status: 200, json: checklist };
  });
  const start = Date.now();
  await page.clock.install({ time: start });
  await page.clock.pauseAt(start + 60_000);
  try {
    await page.goto("/people/run");
    const name = page.locator('[data-run="name"]');
    await advanceUntil(page, page.locator('[data-phase-pending] [data-run="name"]').waitFor({ state: "attached" }));
    await page.clock.runFor(32);
    held.resolve();
    await page.clock.resume();
    await expect(name).toBeFocused();
    await fits(page, "/people/run");
    expect(fixture.unexpected).toEqual([]);
  } finally { held.resolve(); await page.close(); fixture.release(); }
});
