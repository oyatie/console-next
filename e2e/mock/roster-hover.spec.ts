// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { mockScreen } from "./screen";
import { mockRoute } from "./route";
import { facets } from "./fixtures";
import { moveDetail } from "./lifecycle-sheets";
import { screens } from "../states/registry";

test.beforeAll(() => loadCatalog("ko"));

for (const input of ["wheel", "keyboard"]) test(`roster prefetches only settled rows during ${input} scrolling`, async ({ page }, info) => {
  const state = await mockScreen(page, screens[1], "large");
  const reads: string[] = [];
  await mockRoute(page, "get", "/api/v1/employees/{id}", request => {
    reads.push(new URL(request.url()).pathname);
    return { status: 200, json: { ...moveDetail, employee: { ...moveDetail.employee, id: new URL(request.url()).pathname.split("/").at(-1)! } } };
  });
  // This later route must win over the detail route's parameter segment.
  await mockRoute(page, "get", "/api/v1/employees/facets", { status: 200, json: facets(2000) });
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto("/people");
    const grid = page.getByRole("grid", { name: t("people.table"), exact: true });
    const row = grid.locator("[data-row-id]").first();
    await row.waitFor();
    await expect(row).toBeVisible();
    if (input === "keyboard") await row.focus();
    await row.hover();
    await expect.poll(() => reads.length).toBeGreaterThan(0);
    await page.clock.install();
    await page.clock.pauseAt(new Date(Date.now() + 1000));
    await page.clock.runFor(300);
    await page.waitForTimeout(300);
    const start = reads.length;
    for (let step = 0; step < (input === "wheel" ? 12 : 30); step++) {
      if (input === "wheel") await page.mouse.wheel(0, 40);
      else await page.keyboard.press("ArrowDown");
      // Keep a continuous gesture continuous even when the test runner is under load.
      await page.clock.runFor(32);
    }
    // Observe the final dwell, including any request it produces.
    await page.clock.runFor(300);
    await page.clock.resume();
    await page.waitForTimeout(300);
    const count = reads.length - start;
    await info.attach("detail-reads", { body: JSON.stringify({ input, count, reads: reads.slice(start) }), contentType: "application/json" });
    expect(count).toBeLessThanOrEqual(input === "wheel" ? 2 : 3);
  } finally { await page.close(); state.release(); }
});
