// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { mockScreen } from "./screen";
import { mockRoute } from "./route";
import { inbox } from "./fixtures";
import { screens } from "../states/registry";

test.beforeAll(() => loadCatalog("ko"));

for (const path of ["/", "/inbox"]) for (const width of [1440, 390]) for (const selected of width === 390 ? [false, true] : [false]) for (const theme of ["light", "dark"]) {
  test(`held changes overlay ${path} at ${width}px ${theme}${selected ? " with a record open" : ""}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(value => localStorage.setItem("console.theme", value), theme);
    const mock = await mockScreen(page, screens[0], "populated");
    await page.addInitScript(type => {
      const fetch = window.fetch;
      window.fetch = (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        if (new URL(request.url).pathname !== "/api/v1/events") return fetch(input, init);
        return Promise.resolve(new Response(new ReadableStream({ start(controller) {
          controller.enqueue(new TextEncoder().encode(": connected\n\n"));
          const emit = () => controller.enqueue(new TextEncoder().encode(`event: change\ndata: ${JSON.stringify({ type, id: null })}\n\n`));
          window.addEventListener("list-change", emit);
          request.signal.addEventListener("abort", () => { window.removeEventListener("list-change", emit); controller.close(); }, { once: true });
        } }), { headers: { "content-type": "text/event-stream" } }));
      };
    }, "inbox");
    let reads = 0;
    let refreshing = false;
    const queue = inbox(3);
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    await mockRoute(page, "get", "/api/v1/me/action-inbox", async () => {
      reads++;
      if (refreshing) await pending;
      return { status: 200, json: queue };
    });
    try {
      await page.goto(selected ? `${path}?sel=${encodeURIComponent(queue.items[0]!.id)}` : path);
      const list = page.getByRole("region", { name: t("home.inbox.title"), exact: true });
      const row = list.locator("[data-row-id], [data-id]").first();
      await expect(row).toBeAttached();
      if (!selected) await expect(row).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      const before = await row.boundingBox();
      const initialReads = reads;
      const column = list.locator('[data-flexible-columns] > div').first();
      const status = list.locator('[data-flexible-columns] > div').first().locator(':scope > [role="status"]:not([aria-busy])');
      await expect(status).toHaveText("");
      if (selected) await expect(column).toBeHidden();
      await status.evaluate(el => { el.dataset.sameNode = "yes"; });
      await page.screenshot({ path: info.outputPath(`before-${path === "/" ? "home" : "inbox"}-${width}-${theme}.png`), fullPage: true });
      await page.evaluate(() => window.dispatchEvent(new Event("list-change")));
      const chip = (selected ? page : list).getByRole("button", { name: t("live.list.new_rows", { count: 1 }), exact: true });
      await expect(chip).toBeVisible();
      await expect(page.getByRole("button", { name: t("live.list.new_rows", { count: 1 }), exact: true })).toHaveCount(1);
      expect(await chip.evaluate(el => getComputedStyle(el.parentElement!).position)).toBe(selected ? "fixed" : "sticky");
      if (selected) {
        expect((await chip.boundingBox())!.x).toBeGreaterThanOrEqual(0);
        const bounds = (await chip.boundingBox())!;
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
        expect(reads).toBe(initialReads);
        await page.screenshot({ path: info.outputPath(`held-record-${path === "/" ? "home" : "inbox"}-${width}-${theme}.png`), fullPage: true });
        await chip.click();
        await expect.poll(() => reads).toBe(initialReads + 1);
        release();
        await expect(chip).toHaveCount(0);
        await expect(page.getByRole("complementary", { name: t("home.inbox.record.title"), exact: true })).toContainText(queue.items[0]!.title);
        expect(reads).toBe(initialReads + 1);
        expect(mock.unexpected).toEqual([]);
        return;
      }
      expect((await row.boundingBox())!.y).toBe(before!.y);
      expect(reads).toBe(initialReads);
      const trailing = row.locator('[role="cell"], [role="gridcell"], td').last();
      const cellBounds = (await trailing.boundingBox())!;
      const buttonBounds = (await chip.boundingBox())!;
      expect(buttonBounds.y + buttonBounds.height <= cellBounds.y || buttonBounds.y >= cellBounds.y + cellBounds.height || buttonBounds.x + buttonBounds.width <= cellBounds.x || buttonBounds.x >= cellBounds.x + cellBounds.width).toBe(true);
      const chipBounds = (await chip.boundingBox())!;
      expect(chipBounds.y).toBeGreaterThanOrEqual((await list.boundingBox())!.y);
      expect(chipBounds.y).toBeLessThan(before!.y + before!.height);
      expect(chipBounds.x).toBeGreaterThanOrEqual(0);
      expect(chipBounds.x + chipBounds.width).toBeLessThanOrEqual(width);
      await page.screenshot({ path: info.outputPath(`live-${path === "/" ? "home" : "inbox"}-${width}-${theme}.png`), fullPage: true });
      refreshing = true;
      await chip.click();
      await expect.poll(() => reads).toBe(initialReads + 1);
      await expect(status).toHaveAttribute("data-same-node", "yes");
      await expect(row).toHaveCount(0);
      release();
      await expect(chip).toHaveCount(0);
      await expect(status).toHaveAttribute("data-same-node", "yes");
      await expect(row).toBeFocused();
      expect(reads).toBe(initialReads + 1);
      expect(mock.unexpected).toEqual([]);
    } finally { release(); }
  });
}
