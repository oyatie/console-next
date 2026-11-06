// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { expectAxe, fits } from "../a11y";
import { screens } from "../states/registry";
import { inbox, user } from "./fixtures";
import { mockRoute } from "./route";
import { mockScreen } from "./screen";

test.beforeAll(() => loadCatalog("ko"));

for (const width of [1440, 390]) for (const theme of ["light", "dark"]) {
  test(`inbox reads once per arrival when user freshness settles later at ${width}px ${theme}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(value => localStorage.setItem("console.theme", value), theme);
    const mock = await mockScreen(page, screens[0], "populated");
    const reads: string[] = [];
    await mockRoute(page, "get", "/api/v1/me/action-inbox", request => {
      const query = new URL(request.url()).searchParams;
      const filter = query.get("filter")!;
      reads.push(`${filter}:${query.get("cursor") ?? "first"}`);
      const queue = inbox(3);
      return { status: 200, json: { ...queue, items: query.has("cursor") ? [{ ...queue.items[0]!, id: "next-page" }] : queue.items, next_cursor: query.has("cursor") ? null : "next" } };
    });
    await page.goto("/");
    const open = page.getByRole("link", { name: t("home.inbox.viewInbox"), exact: true });
    await expect(open).toBeVisible();
    const queue = page.getByRole("region", { name: t("home.inbox.title"), exact: true });

    for (let arrival = 0; arrival < 2; arrival++) {
      let release!: () => void;
      const held = new Promise<void>(resolve => { release = resolve; });
      await mockRoute(page, "get", "/api/v1/users/me", async () => {
        await held;
        return { status: 200, json: user };
      });
      reads.length = 0;
      const received = page.waitForResponse(response => {
        const url = new URL(response.url());
        return url.pathname === "/api/v1/me/action-inbox" && url.searchParams.get("filter") === "all" && response.ok();
      });
      await open.click();
      await expect(page).toHaveURL(/\/inbox$/);
      await expect.poll(() => reads).toEqual(["all:first"]);
      // The inbox response is cached before its child mounts after the user read.
      await (await received).finished();
      await page.evaluate(() => new Promise(requestAnimationFrame));
      release();
      await expect(queue.locator("[data-id]")).toHaveCount(3);
      expect(reads).toEqual(["all:first"]);
      await expect(page.locator("main header time[datetime]")).toBeVisible();
      await fits(page, `inbox arrival ${width}px ${theme}`);
      await expectAxe(page, `inbox arrival ${width}px ${theme}`);
      if (arrival === 0) {
        await page.screenshot({ path: info.outputPath(`inbox-${width}-${theme}.png`), fullPage: true });
        await page.goBack();
        await expect(open).toBeVisible();
      }
    }

    reads.length = 0;
    const turn = page.getByRole("navigation", { name: t("home.lanes"), exact: true }).getByRole("link", { name: /^내 차례/ });
    await turn.click();
    await expect(turn).toHaveAttribute("aria-current", "page");
    await expect.poll(() => reads).toEqual(["turn:first"]);
    await queue.getByRole("button", { name: t("home.inbox.more"), exact: true }).click();
    await expect(queue.locator('[data-id="next-page"]')).toBeVisible();
    expect(reads).toEqual(["turn:first", "turn:next"]);
    expect(mock.unexpected).toEqual([]);
  });
}
