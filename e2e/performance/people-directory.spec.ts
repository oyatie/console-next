// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { COMPANY, importPeople } from "../people-directory.fixture";
import { tenantWithExecutive } from "../setup-flows";

test("served directory paints its first rows within 2 seconds of the navigation response", { tag: ["@hr", "@performance"] }, async ({ browser }, info) => {
  test.skip(process.env.E2E_SERVED !== "1", "Performance tier requires the served CONSOLE_WEB_DIST build");
  test.setTimeout(600_000);
  const { admin } = await tenantWithExecutive(browser, "directoryperf", COMPANY);
  await importPeople(admin);
  await admin.setViewportSize({ width: 1440, height: 900 });
  await admin.addInitScript(() => {
    const firstRow = () => document.querySelector('[role="grid"][aria-label="직원"] [role="rowheader"]');
    const observer = new MutationObserver(() => {
      if (firstRow()?.textContent?.trim() !== "D-0001") return;
      observer.disconnect();
      requestAnimationFrame(function markVisibleRow() {
        const row = firstRow();
        if (row?.textContent?.trim() === "D-0001" && !row.closest('[inert],[aria-hidden="true"]') && row.checkVisibility({ visibilityProperty: true })) {
          const box = row.getBoundingClientRect();
          if (box.width > 0 && box.height > 0 && box.top < innerHeight && box.bottom > 0 && box.left < innerWidth && box.right > 0) {
            performance.mark("directory:first-rows");
            return;
          }
        }
        requestAnimationFrame(markVisibleRow);
      });
    });
    observer.observe(document, { subtree: true, childList: true });
  });
  for (let run = 1; run <= 3; run++) {
    await admin.goto("/people");
    await expect(admin.getByRole("grid", { name: "직원", exact: true }).getByRole("rowheader", { name: "D-0001", exact: true })).toBeVisible();
    await admin.waitForFunction(() => performance.getEntriesByName("directory:first-rows").length > 0);
    const timing = await admin.evaluate(() => {
      const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming;
      const [paint] = performance.getEntriesByName("directory:first-rows", "mark");
      return { responseStart: navigation.responseStart, firstRows: paint!.startTime - navigation.responseStart };
    });
    await info.attach(`response-to-first-rows-${run}`, { body: JSON.stringify(timing), contentType: "application/json" });
    console.log(`directory first rows ${run}: ${timing.firstRows.toFixed(1)} ms from navigation response`);
    expect(timing.firstRows).toBeGreaterThan(0);
    expect(timing.firstRows).toBeLessThanOrEqual(2000);
  }
  await admin.context().close();
});
