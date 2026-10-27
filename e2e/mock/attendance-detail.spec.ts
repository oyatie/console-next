// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test, type Page } from "@playwright/test";
import type { components } from "@console/api";
import { loadCatalog, t } from "@console/i18n";
import { expectAxe, fits } from "../a11y";
import { screens } from "../states/registry";
import { mockScreen } from "./screen";
import { mockRoute } from "./route";
import { id } from "./fixtures";

test.beforeAll(() => loadCatalog("ko"));

// Keep trace snapshots out of the browser's measured rendering work.
test.use({ trace: "off" });

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
  const grids = page.getByRole("grid", { name: /^일별 · 자세히/ });
  await expect(page.getByText(/^근태 대상 5명/)).toBeVisible();
  await expect(grids).toHaveCount(2);
  await expect(grids.nth(0)).toHaveAttribute("aria-rowcount", "4");
  await expect(grids.nth(1)).toHaveAttribute("aria-rowcount", "3");
  await expect(page.getByRole("region", { name: "판교지점 › 영업1팀", exact: true })).toContainText("3명 · 정상 0 · 일정 없음 3");
  await expect(page.getByRole("region", { name: "판교지점 › 지원팀", exact: true })).toContainText("2명 · 정상 2 · 일정 없음 0");
  await expectAxe(page, `detail ${width}`);
  await fits(page, `detail ${width}`);
  if (width === 390) {
    for (const label of [grids.first().getByRole("rowheader").first(), grids.first().getByRole("button", { name: "일정 지정", exact: true }).first()]) {
      expect(await label.evaluate(el => {
        const text = document.createRange();
        text.selectNodeContents(el);
        return text.getClientRects().length;
      })).toBe(1);
    }
    expect(await grids.first().evaluate(scroller => {
      scroller.scrollLeft = scroller.scrollWidth;
      const scrolls = scroller.scrollWidth > scroller.clientWidth && scroller.scrollLeft > 0;
      scroller.scrollLeft = 0;
      return scrolls;
    })).toBe(true);
  }
  await page.getByRole("button", { name: "일정 없음만", exact: true }).click();
  await expect(grids).toHaveCount(1);
  await expect(grids.first()).toHaveAttribute("aria-rowcount", "4");
  await expect(grids.first().getByRole("button", { name: "일정 지정", exact: true })).toHaveCount(3);
  if (width === 390) await grids.first().evaluate(el => { el.scrollLeft = (el.scrollWidth - el.clientWidth) / 2; });
  const input = grids.first().getByRole("textbox", { name: /^근태직원 1 입력/ });
  await input.click();
  await input.fill("+2");
  await expect(input).toBeFocused();
  await expect(input).toHaveAttribute("aria-invalid", "true");
  await expect(input).toHaveAccessibleDescription(t("attendanceRecords.refusal.overtime_typed"));
  expect(fixture.reads.some(q => q.includes("rows=all") && q.includes("no_schedule_only=true"))).toBe(true);
  expect(fixture.unexpected).toEqual([]);
});

test("2,000-person detail restores folded rows within the 2s page budget", async ({ page }, testInfo) => {
  const fixture = await setup(page, 2000);
  await Promise.all([
    page.waitForResponse(response => new URL(response.url()).pathname === "/api/v1/attendance/days"),
    page.goto("/attendance?tab=day&date=2026-10-06"),
  ]);
  await expect(page.getByText(/^근태 대상 2,000명/)).toBeVisible();
  await page.evaluate(() => {
    document.addEventListener("click", () => performance.mark("detail-start"), { once: true, capture: true });
    const observer = new MutationObserver(() => {
      const grids = Array.from(document.querySelectorAll<HTMLElement>('[role="grid"][aria-label^="일별 · 자세히"]'));
      if (grids.length !== 2 || grids.reduce((count, grid) => count + Number(grid.getAttribute("data-total")), 0) !== 2000 || grids.some(grid => !grid.querySelector("input:enabled"))) return;
      observer.disconnect();
      requestAnimationFrame(() => {
        grids.forEach(grid => grid.getBoundingClientRect());
        requestAnimationFrame(() => performance.measure("detail-load", "detail-start"));
      });
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });
  await page.getByRole("button", { name: "자세히", exact: true }).click();
  await page.waitForFunction(() => performance.getEntriesByName("detail-load").length > 0);
  const elapsed = await page.evaluate(() => performance.getEntriesByName("detail-load")[0]!.duration);
  await testInfo.attach("detail-load-ms", { body: String(elapsed), contentType: "text/plain" });
  console.info(`2,000-person detail: ${elapsed} ms`);
  expect(elapsed).toBeLessThanOrEqual(2000);
  const grids = page.getByRole("grid", { name: /^일별 · 자세히/ });
  await expect(grids.nth(1)).toHaveAttribute("data-total", "1997");
  await expect(grids.nth(1)).toHaveAttribute("aria-rowcount", "1998");
  const renderedEnd = async () => Math.max(...await grids.nth(1).getByRole("row").evaluateAll(rows => rows.map(row => Number(row.getAttribute("aria-rowindex") ?? 0))));
  const before = await renderedEnd();
  expect(before).toBeLessThan(1998);
  await grids.nth(1).evaluate(el => { el.scrollTop = el.scrollHeight; });
  await expect.poll(renderedEnd).toBeGreaterThan(before);
  await expect(grids.nth(1)).toHaveAttribute("aria-rowcount", "1998");
  expect(await grids.getByRole("row").count()).toBeLessThan(100);
  const find = page.getByRole("textbox", { name: "사람 찾기 — 이름·사번", exact: true });
  await find.fill("AT-2000");
  const last = grids.nth(1).getByRole("textbox", { name: /^근태직원 2000 입력/ });
  await expect(grids.nth(1)).toHaveAttribute("aria-rowcount", "2");
  await last.click();
  await last.fill("+2");
  await expect(last).toBeFocused();
  await expect(last).toHaveAccessibleDescription(t("attendanceRecords.refusal.overtime_typed"));
  await find.clear();
  await page.evaluate(() => window.dispatchEvent(new Event("beforeprint")));
  const paper = page.getByRole("table", { name: "일별 · 자세히", exact: true });
  await expect(paper.locator("tbody tr[data-id]")).toHaveCount(2000);
  await page.evaluate(() => window.dispatchEvent(new Event("afterprint")));
  expect(fixture.unexpected).toEqual([]);
});
