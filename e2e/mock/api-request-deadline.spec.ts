// SPDX-License-Identifier: LicenseRef-Proprietary
import { REALTIME } from "../../apps/web/src/lib/freshness";
import { MAX_RETRY_AFTER_MS } from "../../apps/web/src/lib/react/query-defaults";
import { DEFAULT_REQUEST_TIMEOUT_MS } from "../../packages/api/src/request-deadline";
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { expectAxe, fits } from "../a11y";
import { screens } from "../states/registry";
import { employees } from "./fixtures";
import { mockRoute } from "./route";
import { mockScreen } from "./screen";

test.beforeAll(() => loadCatalog("ko"));

for (const width of [1440, 390]) {
  test(`an unanswered roster read ends in the normal retry state at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.clock.install();
    const fixture = await mockScreen(page, screens[1], "loading");
    // Native AbortSignal.timeout uses active browser time, outside Playwright's JS clock.
    await page.addInitScript(heartbeatInterval => {
      AbortSignal.timeout = ms => {
        const controller = new AbortController();
        setTimeout(() => controller.abort(new DOMException("Deadline", "TimeoutError")), ms);
        return controller.signal;
      };
      const fetch = window.fetch;
      // Keep stream recovery from invalidating the held list when the virtual clock advances.
      window.fetch = (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        if (new URL(request.url).pathname !== "/api/v1/events") return fetch(input, init);
        return Promise.resolve(new Response(new ReadableStream({ start(body) {
          const ping = () => body.enqueue(new TextEncoder().encode(": heartbeat\n\n"));
          ping();
          const timer = setInterval(ping, heartbeatInterval);
          request.signal.addEventListener("abort", () => { clearInterval(timer); body.close(); }, { once: true });
        } }), { headers: { "content-type": "text/event-stream" } }));
      };
    }, REALTIME.heartbeatInterval);
    let attempts = 0;
    page.on("request", request => { if (new URL(request.url()).pathname === screens[1].read) attempts++; });
    try {
      await page.goto(screens[1].path);
      const main = page.getByRole("main");
      await expect(main.locator('[role="status"][aria-busy="true"]').first()).toBeVisible();
      // Exhaust the existing three-attempt read budget; this test adds no retries or real waits.
      for (let attempt = 1; attempt <= 3; attempt++) {
        await expect.poll(() => attempts).toBe(attempt);
        await page.clock.runFor(DEFAULT_REQUEST_TIMEOUT_MS);
        await page.clock.runFor(MAX_RETRY_AFTER_MS);
      }
      const retry = main.getByRole("button", { name: t("common.retry"), exact: true });
      await expect(main.getByRole("alert")).toContainText(t("common.loadFailed.title"));
      await expect(retry).toHaveCount(1);
      await expect(retry).toBeVisible();
      for (const theme of ["light", "dark"]) {
        await page.locator("html").evaluate((element, value) => { element.dataset.theme = value; }, theme);
        await fits(page, `roster-deadline-${width}-${theme}`);
        await expectAxe(page, `roster deadline ${width} ${theme}`);
        await page.screenshot({ path: test.info().outputPath(`${theme}.png`), fullPage: true });
      }
      await mockRoute(page, "get", "/api/v1/employees", { status: 200, json: { items: employees(3), total: 3, offset: 0, limit: 100, next_cursor: null } });
      await retry.click();
      await expect(main.getByRole("grid").locator("[data-row-id]")).toHaveCount(3);
      await expect(retry).toHaveCount(0);
      expect(attempts).toBe(4);
      expect(fixture.unexpected).toEqual([]);
    } finally {
      fixture.release();
      await page.close();
    }
  });
}
