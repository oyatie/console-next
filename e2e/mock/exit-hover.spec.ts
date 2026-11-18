// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import type { components } from "@console/api";
import { loadCatalog, t } from "@console/i18n";
import { mockScreen } from "./screen";
import { mockRoute } from "./route";
import { AT, id } from "./fixtures";
import { fits } from "../a11y";
import { screens } from "../states/registry";

test.beforeAll(() => loadCatalog("ko"));

for (const input of ["wheel", "keyboard"]) test(`exit list prefetches only settled rows during ${input} scrolling`, async ({ page }, info) => {
  const state = await mockScreen(page, screens[1], "populated");
  const rows: components["schemas"]["EmployeeExitCase"][] = Array.from({ length: 300 }, (_, i) => ({
    id: id(8000 + i), employee_id: id(9000 + i), employee_name: `Exit person ${i}`, employee_number: `EXIT-${i}`, company: "Screen test company",
    status: "REPORTED", effective_exit_date: "2026-10-26", site_manager_note: "Personal reasons", involuntary: false, notice_required: false,
    dismissal_notice: null, protected_periods: [], reported_by: id(1), reported_by_name: "Reporter", reported_at: AT,
    hr_confirmed_by_name: null, hq_confirmed_by_name: null, approval_submitted_by_name: null, closed_by_name: null,
    exit_lifecycle_event_id: null, exit_event_state: null, next_actions: [{ key: "confirm_exit" }],
  }));
  await mockRoute(page, "get", "/api/v1/hr/exit-cases", request => {
    const url = new URL(request.url());
    const limit = Number(url.searchParams.get("limit") ?? 100);
    const offset = Number(url.searchParams.get("offset") ?? 0);
    return { status: 200, json: { items: rows.slice(offset, offset + limit), total: rows.length, limit, offset } };
  });
  const reads: string[] = [];
  await mockRoute(page, "get", "/api/v1/hr/exit-cases/{id}", request => {
    const key = new URL(request.url()).pathname.split("/").at(-1)!;
    reads.push(key);
    return { status: 200, json: rows.find(row => row.id === key)! };
  });
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto("/people?tab=exits");
    const grid = page.getByRole("grid", { name: t("exit.list.title"), exact: true });
    const first = grid.getByRole("link", { name: rows[0]!.employee_name, exact: true });
    await first.hover();
    await expect.poll(() => reads.length).toBe(1);
    if (input === "keyboard") await first.focus();
    await page.clock.install();
    await page.clock.pauseAt(new Date(Date.now() + 1000));
    const start = reads.length;
    for (let step = 0; step < 12; step++) {
      if (input === "wheel") {
        const previous = await grid.evaluate(el => el.scrollTop);
        await page.mouse.wheel(0, 40);
        await expect.poll(() => grid.evaluate(el => el.scrollTop)).toBeGreaterThan(previous);
      } else await page.keyboard.press("ArrowDown");
      await page.clock.runFor(32);
    }
    expect(reads.slice(start)).toEqual([]);
    await page.clock.runFor(300);
    await page.clock.resume();
    // A newly focused link must still prefetch immediately, independently of the pointer dwell.
    const last = grid.getByRole("link").last();
    const focusedId = await last.evaluate(el => el.closest<HTMLElement>('[data-row-id]')!.dataset.rowId!);
    await last.focus();
    await expect.poll(() => reads.includes(focusedId)).toBe(true);
    await info.attach("detail-reads", { body: JSON.stringify({ input, reads: reads.slice(start) }), contentType: "application/json" });
    expect(reads.length - start).toBeLessThanOrEqual(2);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator("html").evaluate(el => el.dataset.theme = "dark");
    await expect(grid).toHaveAttribute("data-layout", "cards");
    await fits(page, "Exit list");
    await expect(page.getByRole("main").locator("h1")).toHaveCount(1);
    await page.screenshot({ path: info.outputPath("exit-phone-dark.png"), fullPage: true });
    expect(state.unexpected).toEqual([]);
  } finally { await page.close(); state.release(); }
});
