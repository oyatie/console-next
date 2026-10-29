// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test, type Page } from "@playwright/test";
import { expectAxe, fits } from "../a11y";
import { screens } from "../states/registry";
import { mockScreen } from "./screen";
import { mockRoute } from "./route";
import { failure, id } from "./fixtures";

async function weeklyFixture(page: Page) {
  const fixture = await mockScreen(page, screens[0], "populated");
  await mockRoute(page, "get", "/api/v1/attendance/schedule/tree", { status: 200, json: { date: "2026-10-26", people_total: 0, people_unscheduled: 0, holidays_loaded: true, nodes: [] } });
  return fixture;
}

for (const width of [1440, 390]) test(`weekly unknown explains its reason at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  const fixture = await weeklyFixture(page);
  const weeks: string[] = [];
  await mockRoute(page, "get", "/api/v1/attendance/week52", request => {
    const week = new URL(request.url()).searchParams.get("week_start")!;
    weeks.push(week);
    const tones = week === "2026-10-26" ? ["UNKNOWN", "DANGER", "WARN", "OK"] : ["DANGER", "WARN", "OK"];
    return { status: 200, json: { week_start: week, items: tones.map((tone, i) => ({
      employee_id: id(100 + i), name: `주간직원 ${i + 1}`, week_start: week,
      current_hours: 45, projected_hours: 45, tone: tone as "UNKNOWN" | "DANGER" | "WARN" | "OK", acked: false,
    })) } };
  });
  await page.goto("/attendance?tab=week&date=2026-10-28");
  const table = page.getByRole("grid", { name: "연장근로", exact: true });
  await expect(table.getByRole("row").filter({ hasText: "주간직원 1" })).toContainText("확인 불가 · 법정 근로시간 대장 미등록");
  const reason = page.getByText("이 주의 법정 근로시간 기준이나 설정된 주의 기준을 확인할 수 없습니다.", { exact: true });
  await expect(reason).toHaveCount(1);
  await expect(table).toContainText("위험");
  await expect(table).toContainText("주의");
  await expect(table).toContainText("기준 이내");
  await expectAxe(page, `weekly ${width}`);
  await fits(page, `weekly ${width}`);
  await page.getByRole("button", { name: "지난주", exact: true }).click();
  await expect.poll(() => weeks.at(-1)).toBe("2026-10-19");
  await expect(table.getByRole("row").filter({ hasText: "주간직원" })).toHaveCount(3);
  await expect(table.getByText("확인 불가 · 법정 근로시간 대장 미등록", { exact: true })).toHaveCount(0);
  await expect(reason).toHaveCount(0);
  expect(weeks[0]).toBe("2026-10-26");
  expect(fixture.unexpected).toEqual([]);
});

for (const width of [1440, 390]) for (const font of ["default", "serif"]) test(`2,000 weekly rows keep readable cells at ${width}px (${font})`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  const fixture = await weeklyFixture(page);
  await mockRoute(page, "get", "/api/v1/attendance/week52", { status: 200, json: {
    week_start: "2026-10-26", items: Array.from({ length: 2000 }, (_, i) => ({
      employee_id: id(100 + i), name: i === 1999 ? "박하늘별님구름햇님보다사랑스러우리" : `주간직원 ${i + 1}`, week_start: "2026-10-26",
      current_hours: 45.5, projected_hours: 45.5, tone: "OK" as const, acked: false,
    })),
  } });
  await page.goto("/attendance?tab=week&date=2026-10-26");
  if (font === "serif") await page.addStyleTag({ content: '[role="grid"] { font-family: serif; }' });
  const table = page.getByRole("grid", { name: "연장근로", exact: true });
  await expect(table).toHaveAttribute("aria-rowcount", "2001");
  await expect(table.getByText("45.5시간", { exact: true }).first()).toBeVisible();
  await table.evaluate(el => { el.scrollTop = el.scrollHeight; });
  const name = table.getByText("박하늘별님구름햇님보다사랑스러우리", { exact: true });
  await expect(name).toBeVisible();
  expect(await name.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await expectAxe(page, `2,000 weekly rows ${width}/${font}`);
  await fits(page, `2,000 weekly rows ${width}/${font}`);
  expect(fixture.unexpected).toEqual([]);
});

for (const status of [403, 500] as const) test(`weekly ${status} uses the shared read failure state`, async ({ page }) => {
  await weeklyFixture(page);
  await mockRoute(page, "get", "/api/v1/attendance/week52", { status, json: failure(status === 403 ? "forbidden" : "internal") });
  await page.goto("/attendance?tab=week&date=2026-10-26");
  await expect(page.getByRole("grid", { name: "연장근로", exact: true })).toHaveCount(0);
  if (status === 500) await expect(page.getByRole("button", { name: "다시 불러오기", exact: true })).toBeVisible({ timeout: 15_000 });
  else await expect(page.locator(".state")).toBeVisible();
});
