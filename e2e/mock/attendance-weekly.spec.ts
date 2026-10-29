// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { expectAxe, fits } from "../a11y";
import { screens } from "../states/registry";
import { mockScreen } from "./screen";
import { mockRoute } from "./route";
import { failure, id } from "./fixtures";

for (const width of [1440, 390]) test(`weekly unknown explains its reason at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  const fixture = await mockScreen(page, screens[0], "populated");
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
  const table = page.getByRole("table", { name: "주간 근로시간", exact: true });
  await expect(table.getByRole("row").filter({ hasText: "주간직원 1" })).toContainText("확인 불가");
  const reason = page.getByText("이 주의 법정 근로시간 기준이나 설정된 주의 기준을 확인할 수 없습니다.", { exact: true });
  await expect(reason).toHaveCount(1);
  await expect(table).toContainText("한도 도달");
  await expect(table).toContainText("주의");
  await expect(table).toContainText("기준 이내");
  await expectAxe(page, `weekly ${width}`);
  await fits(page, `weekly ${width}`);
  await page.getByRole("button", { name: "이전 주", exact: true }).click();
  await expect.poll(() => weeks.at(-1)).toBe("2026-10-19");
  await expect(table.locator("tbody tr")).toHaveCount(3);
  await expect(table.getByText("확인 불가", { exact: true })).toHaveCount(0);
  await expect(reason).toHaveCount(0);
  expect(weeks[0]).toBe("2026-10-26");
  expect(fixture.unexpected).toEqual([]);
});

for (const width of [1440, 390]) for (const font of ["default", "serif"]) test(`2,000 weekly rows keep one heading and readable cells at ${width}px (${font})`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  const fixture = await mockScreen(page, screens[0], "populated");
  const week = "2026-10-26";
  await mockRoute(page, "get", "/api/v1/attendance/week52", { status: 200, json: {
    week_start: week, items: Array.from({ length: 2000 }, (_, i) => ({
      employee_id: id(100 + i), name: i === 1999 ? "박하늘별님구름햇님보다사랑스러우리" : `주간직원 ${i + 1}`, week_start: week,
      current_hours: 45.5, projected_hours: 45.5, tone: (["UNKNOWN", "DANGER", "WARN", "OK"] as const)[i % 4]!, acked: false,
    })),
  } });
  await page.goto(`/attendance?tab=week&date=${week}`);
  if (font === "serif") await page.addStyleTag({ content: "table { font-family: serif; }" });
  await page.evaluate(() => document.fonts.ready);
  const region = page.getByRole("region", { name: "주간 근로시간", exact: true });
  const table = region.getByRole("table", { name: "주간 근로시간", exact: true });
  await expect(table.locator("tbody tr")).toHaveCount(2000);
  await expect(region.getByRole("heading", { level: 2 })).toHaveCount(1);
  const reason = "이 주의 법정 근로시간 기준이나 설정된 주의 기준을 확인할 수 없습니다.";
  await expect(region.getByText(reason, { exact: true })).toHaveCount(1);
  await expect(table.getByText(reason, { exact: true })).toHaveCount(0);
  for (const state of ["확인 불가", "한도 도달", "주의", "기준 이내"]) await expect(table.getByText(state, { exact: true })).toHaveCount(500);
  if (width === 390) {
    expect(await table.locator('tbody [data-type="duration"], tbody [data-type="status"]').evaluateAll(cells => cells.every(cell => {
      const bounds = cell.getBoundingClientRect();
      const text = document.createRange();
      text.selectNodeContents(cell);
      const value = text.getBoundingClientRect();
      const chip = cell.firstElementChild?.getBoundingClientRect();
      return cell.scrollWidth <= cell.clientWidth && cell.scrollHeight <= cell.clientHeight
        && value.left >= bounds.left && value.right <= bounds.right && value.top >= bounds.top && value.bottom <= bounds.bottom
        && (!chip || chip.left >= bounds.left && chip.right <= bounds.right && chip.top >= bounds.top && chip.bottom <= bounds.bottom);
    })), "no hours or status cell is clipped").toBe(true);
    expect(await table.locator("tbody tr").evaluateAll(rows => rows.every(row => getComputedStyle(row).display === "grid")), "phone rows use the shared cards").toBe(true);
    expect(await table.locator("tbody td:first-child").evaluateAll(cells => cells.every(cell => {
      const text = document.createRange();
      text.selectNodeContents(cell);
      const name = text.getBoundingClientRect();
      const bounds = cell.getBoundingClientRect();
      return cell.getAttribute("data-card") === "title" && name.left >= bounds.left && name.right <= bounds.right
        && name.top >= bounds.top && name.bottom <= bounds.bottom;
    })), "every full employee name fits in its card title").toBe(true);
  } else expect(await table.evaluate(el => {
    const height = el.querySelector("thead tr")!.getBoundingClientRect().height;
    return Array.from(el.querySelectorAll("tbody tr")).every(row => row.getBoundingClientRect().height <= height + 1);
  }), "desktop rows keep the table's standard row height").toBe(true);
  await expect(table.locator('tbody [tabindex="0"]')).toHaveCount(0);
  const fullName = "박하늘별님구름햇님보다사랑스러우리";
  const nameCell = table.getByRole("cell", { name: fullName, exact: true });
  await expect(nameCell).toHaveAccessibleName(fullName);
  if (font === "serif") expect(await nameCell.evaluate(el => getComputedStyle(el).fontFamily)).toBe("serif");
  await nameCell.hover();
  await expect(nameCell).toHaveAttribute("title", fullName);
  await expect(nameCell).toHaveText(fullName);
  await expect(nameCell).toHaveAttribute("title", fullName);
  await expectAxe(page, `2,000 weekly rows ${width}`, {
    include: ".page > header, .page > section > div:first-child, .page [data-placement], .page table caption, .page table thead, .page table tbody tr:nth-child(-n+3)",
  });
  await fits(page, `2,000 weekly rows ${width}`);
  expect(fixture.unexpected).toEqual([]);
});

for (const status of [403, 500] as const) test(`weekly ${status} uses the shared read failure state`, async ({ page }) => {
  await mockScreen(page, screens[0], "populated");
  await mockRoute(page, "get", "/api/v1/attendance/week52", { status, json: failure(status === 403 ? "forbidden" : "internal") });
  await page.goto("/attendance?tab=week&date=2026-10-26");
  await expect(page.getByRole("table", { name: "주간 근로시간", exact: true })).toHaveCount(0);
  if (status === 500) await expect(page.getByRole("button", { name: "다시 불러오기", exact: true })).toBeVisible({ timeout: 15_000 });
  else await expect(page.locator(".state")).toBeVisible();
});
