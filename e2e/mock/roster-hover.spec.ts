// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { mockScreen } from "./screen";
import { mockRoute } from "./route";
import { facets, failure } from "./fixtures";
import { moveDetail } from "./lifecycle-sheets";
import { screens } from "../states/registry";

test.beforeAll(() => loadCatalog("ko"));

for (const input of ["wheel", "keyboard"]) test(`roster reads an employee only after selection following ${input} scrolling`, async ({ page }, info) => {
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
    await page.clock.install();
    await page.clock.pauseAt(new Date(Date.now() + 1000));
    if (input === "keyboard") await row.focus();
    else await row.hover();
    await page.clock.runFor(300);
    for (let step = 0; step < (input === "wheel" ? 12 : 30); step++) {
      if (input === "wheel") await page.mouse.wheel(0, 40);
      else await page.keyboard.press("ArrowDown");
      // Keep a continuous gesture continuous even when the test runner is under load.
      await page.clock.runFor(32);
    }
    await page.clock.runFor(300);
    await page.clock.resume();
    await page.waitForTimeout(300);
    await info.attach("reads-before-selection", { body: JSON.stringify({ input, reads }), contentType: "application/json" });
    expect(reads).toEqual([]);
    if (input === "wheel") await grid.evaluate(el => el.scrollTo(0, 0));
    const selected = input === "keyboard" ? grid.locator("[data-row-id]:focus") : row;
    const id = await selected.getAttribute("data-row-id");
    expect(id).toBeTruthy();
    if (input === "keyboard") await selected.press("Enter");
    else await grid.locator(`[data-row-id="${id}"]`).getByRole("rowheader").last().click();
    await expect.poll(() => reads).toEqual([`/api/v1/employees/${id}`]);
  } finally { await page.close(); state.release(); }
});

test("a record opened after access changes uses the current refusal", async ({ page }) => {
  const state = await mockScreen(page, screens[1], "large");
  let permitted = true;
  let reads = 0;
  await mockRoute(page, "get", "/api/v1/employees/{id}", () => {
    reads++;
    return permitted ? { status: 200, json: moveDetail } : { status: 403, json: failure("access_denied") };
  });
  await mockRoute(page, "get", "/api/v1/employees/facets", { status: 200, json: facets(2000) });
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto("/people");
    const row = page.getByRole("grid", { name: t("people.table"), exact: true }).locator("[data-row-id]").first();
    await row.hover();
    await row.focus();
    await page.waitForTimeout(300);
    expect(reads).toBe(0);
    permitted = false;
    await row.getByRole("rowheader").last().click();
    await expect(page.getByRole("heading", { name: t("common.denied.panel"), exact: true })).toBeVisible();
    expect(reads).toBe(1);
  } finally { state.release(); }
});
