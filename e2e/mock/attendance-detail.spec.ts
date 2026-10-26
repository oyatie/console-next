// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test, type Page } from "@playwright/test";
import type { components } from "@console/api";
import { expectAxe, fits } from "../a11y";
import { screens } from "../states/registry";
import { mockScreen } from "./screen";
import { mockRoute } from "./route";
import { id } from "./fixtures";

type Board = components["schemas"]["AttendanceDayBoard"];
async function setup(page: Page, count: number) {
  const fixture = await mockScreen(page, screens[0], "populated");
  const rows: Board["groups"][number]["rows"] = Array.from({ length: count }, (_, n) => ({
    employee_id: id(n + 100), employee_number: `AT-${n + 1}`, name: `근태직원 ${n + 1}`, own: false,
    month_state: { state: "OPEN" },
    day: { date: "2026-10-06", plan: { kind: n < 3 ? "NO_SCHEDULE" : "REST_DAY", holiday_work: false },
      marks: n < 3 ? ["NO_SCHEDULE"] : [],
      recognition: { recorded: 0, recognised: 0, regular: 0, approved: 0, early_unrecognised: 0, late_unrecognised: 0, late_in: 0, early_out: 0, away: 0, approval_unused: 0 } },
  }));
  const groups = [rows.slice(0, 3), rows.slice(3)].map((people, n) => ({
    workplace_id: id(1), unit_id: id(n + 2), name: `판교지점 › ${n ? "지원팀" : "영업1팀"}`,
    people: people.length, normal: n ? people.length : 0, no_schedule: n ? 0 : people.length,
    marks: { blocking: n ? 0 : people.length, decision: 0, info: 0 }, rows: people, hidden: 0,
  }));
  await mockRoute(page, "get", "/api/v1/attendance/schedule/tree", { status: 200, json: { date: "2026-10-06", holidays_loaded: true, nodes: [], people_total: count, people_unscheduled: 3 } });
  const reads: string[] = [];
  await mockRoute(page, "get", "/api/v1/attendance/days", request => {
    const query = new URL(request.url()).searchParams;
    reads.push(query.toString());
    const all = query.get("rows") === "all";
    const filtered = query.get("no_schedule_only") === "true";
    return { status: 200, json: {
      date: "2026-10-06", judged: true,
      ledger: { people: count, no_schedule: 3, rest: count - 3, normal: 0, no_record: 0, pending: 0, missing_out: 0, absent: 0, outside: 0, trip: 0, late_or_early: 0 },
      marks: { blocking: 3, decision: 0, info: 0 },
      groups: groups.filter((_, n) => !filtered || n === 0).map((g, n) => ({ ...g, rows: all || n === 0 ? g.rows : [], hidden: all || n === 0 || filtered ? 0 : g.people })),
    } };
  });
  return { ...fixture, reads };
}

for (const width of [1440, 390]) test(`detail population, group headers and composed filters at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  const fixture = await setup(page, 5);
  await page.goto("/attendance?tab=day&date=2026-10-06&detail=true");
  const table = page.getByRole("table", { name: "일별 · 자세히" });
  await expect(page.getByText(/^근태 대상 5명/)).toBeVisible();
  await expect(table.locator("tbody tr[data-id]")).toHaveCount(5);
  await expect(table.locator('th[scope="rowgroup"]')).toContainText(["영업1팀 · 3명 · 정상 0 · 일정 없음 3", "지원팀 · 2명 · 정상 2 · 일정 없음 0"]);
  await expectAxe(page, `detail ${width}`);
  await fits(page, `detail ${width}`);
  if (width === 390) {
    for (const label of [table.locator('tbody tr[data-id] td:nth-child(2)').first(), table.getByRole("button", { name: "일정 지정", exact: true }).first()]) {
      expect(await label.evaluate(el => {
        const text = document.createRange();
        text.selectNodeContents(el);
        return text.getClientRects().length;
      })).toBe(1);
    }
    expect(await table.evaluate(el => {
      const scroller = el.parentElement!;
      scroller.scrollLeft = scroller.scrollWidth;
      return scroller.scrollWidth > scroller.clientWidth && scroller.scrollLeft > 0;
    })).toBe(true);
  }
  await page.getByRole("button", { name: "일정 없음만", exact: true }).click();
  await expect(table.locator("tbody tr[data-id]")).toHaveCount(3);
  await expect(table.getByRole("button", { name: "일정 지정", exact: true })).toHaveCount(3);
  expect(fixture.reads.some(q => q.includes("rows=all") && q.includes("no_schedule_only=true"))).toBe(true);
  expect(fixture.unexpected).toEqual([]);
});

test("2,000-person detail restores folded rows within the 2s page budget", async ({ page }, testInfo) => {
  const fixture = await setup(page, 2000);
  await page.goto("/attendance?tab=day&date=2026-10-06");
  await expect(page.getByText(/^근태 대상 2,000명/)).toBeVisible();
  const start = Date.now();
  await page.getByRole("button", { name: "자세히", exact: true }).click();
  const table = page.getByRole("table", { name: "일별 · 자세히" });
  await expect(table.locator("tbody tr[data-id]")).toHaveCount(2000);
  await expect(table.getByRole("textbox", { name: /^근태직원 2000 입력/ })).toBeEnabled();
  await table.evaluate(el => { el.getBoundingClientRect(); return new Promise<void>(resolve => requestAnimationFrame(() => resolve())); });
  const elapsed = Date.now() - start;
  await testInfo.attach("detail-load-ms", { body: String(elapsed), contentType: "text/plain" });
  console.info(`2,000-person detail: ${elapsed} ms`);
  expect(elapsed).toBeLessThanOrEqual(2000);
  expect(fixture.unexpected).toEqual([]);
});
