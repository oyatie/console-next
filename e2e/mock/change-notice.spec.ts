// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { mockScreen } from "./screen";
import { lifecycleSheetScreens } from "../states/lifecycle-sheets";
import { go } from "../flows";
import { AT } from "./fixtures";
import { moveDetail } from "./lifecycle-sheets";

for (const width of [1440, 390]) for (const theme of ["light", "dark"]) {
  test(`record change notice clears personnel actions at ${width}px ${theme}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 844 });
    await mockScreen(page, lifecycleSheetScreens[0], "populated");
    await page.addInitScript(({ id, at, theme }) => {
      localStorage.setItem("console.theme", theme);
      const fetch = window.fetch;
      window.fetch = (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        if (new URL(request.url).pathname !== "/api/v1/events") return fetch(input, init);
        return Promise.resolve(new Response(new ReadableStream({ start(controller) {
          controller.enqueue(new TextEncoder().encode(": connected\n\n"));
          const emit = () => controller.enqueue(new TextEncoder().encode(`event: change\ndata: ${JSON.stringify({ type: "employee", id, at })}\n\n`));
          window.addEventListener("record-change", emit);
          request.signal.addEventListener("abort", () => {
            window.removeEventListener("record-change", emit);
            controller.close();
          }, { once: true });
        } }), { headers: { "content-type": "text/event-stream" } }));
      };
    }, { id: moveDetail.employee.id, at: AT, theme });
    await go(page, `/people/${moveDetail.employee.id}`);
    const actions = page.getByRole("group", { name: "인사카드 동작", exact: true });
    await expect(actions).toBeVisible();
    await page.evaluate(() => window.dispatchEvent(new Event("record-change")));
    const notice = page.getByRole("status").filter({ has: page.getByRole("button", { name: "알림 닫기", exact: true }) });
    await expect(notice).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    const n = (await notice.boundingBox())!;
    const a = (await actions.boundingBox())!;
    expect(n.y + n.height <= a.y || a.y + a.height <= n.y || n.x + n.width <= a.x || a.x + a.width <= n.x).toBe(true);
    expect(n.x).toBeGreaterThanOrEqual(0);
    expect(n.x + n.width).toBeLessThanOrEqual(width);
    await page.screenshot({ path: info.outputPath("record-notice.png") });
    await actions.getByRole("button", { name: "발령", exact: true }).click();
    await expect(page.getByRole("menuitem", { name: /전보/ })).toBeVisible();
  });
}
