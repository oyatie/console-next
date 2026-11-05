// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import type { components } from "@console/api";
import { expectAxe, fits } from "../a11y";
import { openGradeFix } from "../helpers/grade-fix";
import { routeReady } from "../flows";
import { statement } from "../sheet";
import { AT, id } from "./fixtures";
import { moveDetail } from "./lifecycle-sheets";
import { mockRoute } from "./route";
import { mockScreen } from "./screen";
import { lifecycleSheetScreens } from "../states/lifecycle-sheets";

for (const width of [1440, 390]) for (const theme of ["light", "dark"]) {
  test(`a modal Sheet preserves the personnel card grid at ${width}px in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.clock.setFixedTime(new Date(AT));
    await page.addInitScript(value => localStorage.setItem("console.theme", value), theme);
    const fixture = await mockScreen(page, lifecycleSheetScreens[0], "populated");
    let applied = false;
    const event: components["schemas"]["EmployeeLifecycleEvent"] = {
      id: id(4050), employee_id: id(4000), event_type: "PROMOTE", state: "APPLIED", to_status: "ACTIVE",
      effective_date: AT.slice(0, 10), comment: "", to_grade_id: id(4051), created_by: id(1), created_by_name: "김담당", created_at: AT,
      signoffs: { privacy_notice_ack: false, korean_labor_law_ack: false, payroll_cutoff_ack: false, retirement_settlement_ack: false },
    };
    await mockRoute(page, "get", "/api/v1/job-titles", { status: 200, json: { items: [{ id: id(4051), kind: "GRADE", label: "G3", grade_rank: 3, active: true }], can_manage: false } });
    await mockRoute(page, "get", "/api/v1/employees/{id}", () => ({ status: 200, json: { ...moveDetail, classification: { ...moveDetail.classification, grade_id: applied ? id(4051) : null } } }));
    await mockRoute(page, "post", "/api/v1/employees/{id}/lifecycle-events", () => {
      applied = true;
      return { status: 200, json: event };
    });
    await page.goto(`/people/${id(4000)}`);
    await routeReady(page);
    await page.evaluate(() => document.fonts.ready);
    const record = page.locator("#s2");
    const geometry = () => record.evaluate(element => ({
      width: element.getBoundingClientRect().width,
      columns: getComputedStyle(element.querySelector("[data-two]")!).gridTemplateColumns.split(" ").length,
    }));
    const before = await geometry();
    const shifts = await record.evaluateHandle(element => {
      const entries: { value: number; before: number; after: number }[] = [];
      if (PerformanceObserver.supportedEntryTypes.includes("layout-shift")) new PerformanceObserver(list => {
        for (const entry of list.getEntries() as (PerformanceEntry & { value: number; sources: { node: Node; previousRect: DOMRectReadOnly; currentRect: DOMRectReadOnly }[] })[]) {
          for (const source of entry.sources) if (source.node === element && source.previousRect.width && source.currentRect.width && source.previousRect.width !== source.currentRect.width)
            entries.push({ value: entry.value, before: source.previousRect.width, after: source.currentRect.width });
        }
      }).observe({ type: "layout-shift" });
      return entries;
    });
    const sheet = await openGradeFix(page, false);
    expect.soft(await geometry()).toEqual(before);
    await statement(sheet.getByRole("radio", { name: "G3", exact: true })).click();
    await statement(sheet.getByRole("radio", { name: /^오늘/ })).click();
    await page.screenshot({ path: test.info().outputPath("sheet.png") });
    await fits(page, `personnel-sheet/${width}/${theme}`);
    await expectAxe(page, "grade change Sheet", { include: "[role=dialog]" });
    const reread = page.waitForResponse(response => response.request().method() === "GET"
      && new URL(response.url()).pathname === `/api/v1/employees/${id(4000)}/lifecycle-events`);
    await sheet.getByRole("button", { name: "승진 1명 적용", exact: true }).click();
    await (await reread).finished();
    await expect(sheet).toBeHidden({ timeout: 1000 });
    await expect(page.locator("#f-grade")).toContainText("G3");
    await page.screenshot({ path: test.info().outputPath("card.png") });
    expect(await geometry()).toEqual(before);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    expect(await shifts.jsonValue(), "the background record must not change width when a modal opens or closes").toEqual([]);
    expect(applied).toBe(true);
    expect(fixture.unexpected).toEqual([]);
  });
}
