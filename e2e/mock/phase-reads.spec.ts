// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { fits } from "../a11y";
import { entityRecordPath, mockEntityRecord } from "../states/entity-record";
import { checklist } from "./fixtures";
import { mockRoute } from "./route";

test.beforeAll(() => loadCatalog("ko"));

for (const width of [1440, 390]) test(`a held phase starts every record read before the checklist answers at ${width}px @ui-state`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 });
  const fixture = await mockEntityRecord(page, "populated");
  const held = Promise.withResolvers<void>();
  let checklistRequested = false;
  let checklistAnswered = false;
  await mockRoute(page, "get", "/api/v1/onboarding/checklist", async () => {
    checklistRequested = true;
    await held.promise;
    checklistAnswered = true;
    return { status: 200, json: checklist };
  });
  const paths = ["", "/documents", "/revisions"].map(suffix => `/api/v1/legal-entities/${fixture.entity.id}${suffix}`);
  const started = new Map<string, number>();
  page.on("request", request => {
    const path = new URL(request.url()).pathname;
    if (paths.includes(path)) started.set(path, Date.now());
  });
  const start = Date.now();
  await page.clock.install({ time: start });
  await page.clock.pauseAt(start + 60_000);
  try {
    const assets = [".js", ".css"].map(extension => page.waitForResponse(response => {
      const path = new URL(response.url()).pathname;
      return path.startsWith("/assets/entity-record-") && path.endsWith(extension);
    }));
    await page.goto(`${entityRecordPath}?tab=documents`);
    await Promise.all(assets.map(async response => (await response).finished()));
    await expect.poll(async () => {
      await page.clock.runFor(1);
      return { checklistRequested, reads: [...started.keys()].sort() };
    }).toEqual({ checklistRequested: true, reads: [...paths].sort() });
    expect(checklistAnswered).toBe(false);
    const main = page.getByRole("main");
    await expect(main.locator("[data-phase-pending]")).toHaveAttribute("inert", "");
    await expect(main.getByRole("heading", { level: 1 })).toHaveCount(0);
    await info.attach("record-read-starts", { body: JSON.stringify([...started]), contentType: "application/json" });
    held.resolve();
    await page.clock.resume();
    await expect(main.getByRole("heading", { name: fixture.entity.current!.name!, level: 1 })).toBeVisible();
    await expect(main.getByRole("tab", { selected: true })).toContainText(t("entityRecord.tab.documents"));
    await fits(page, `record reads/${width}`);
    await page.locator("html").evaluate(el => el.dataset.theme = "dark");
    await fits(page, `record reads/${width}/dark`);
    await info.attach("settled-dark", { body: await page.screenshot(), contentType: "image/png" });
    expect(fixture.unexpected).toEqual([]);
  } finally { held.resolve(); await page.close(); fixture.release(); }
});
