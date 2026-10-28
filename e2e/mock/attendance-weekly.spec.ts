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

for (const width of [1440, 390]) for (const font of ["default", "serif"]) test(`2,000 unknown weekly rows keep one heading and readable names at ${width}px (${font})`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  const fixture = await mockScreen(page, screens[0], "populated");
  const week = "2026-10-26";
  await mockRoute(page, "get", "/api/v1/attendance/week52", { status: 200, json: {
    week_start: week, items: Array.from({ length: 2000 }, (_, i) => ({
      employee_id: id(100 + i), name: i === 1999 ? "박하늘별님구름햇님보다사랑스러우리" : `주간직원 ${i + 1}`, week_start: week,
      current_hours: 45, projected_hours: 45, tone: "UNKNOWN" as const, acked: false,
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
  await expect(table.getByText("확인 불가", { exact: true })).toHaveCount(2000);
  expect(await table.evaluate(el => {
    const height = el.querySelector("thead tr")!.getBoundingClientRect().height;
    return Array.from(el.querySelectorAll("tbody tr")).every(row => row.getBoundingClientRect().height <= height + 1);
  }), "every row keeps the table's standard row height").toBe(true);
  if (width === 390) {
    expect(await table.locator("tbody td:first-child").evaluateAll(cells => cells.every(cell => {
      const text = document.createRange();
      text.selectNodeContents(cell.firstElementChild ?? cell);
      const name = text.getBoundingClientRect();
      const bounds = cell.getBoundingClientRect();
      const style = getComputedStyle(cell);
      return name.height <= parseFloat(style.lineHeight) && name.top >= bounds.top && name.bottom <= bounds.bottom && style.whiteSpace === "nowrap"
        && style.overflow === "hidden" && style.textOverflow === "ellipsis";
    })), "every employee name fits on one line").toBe(true);
  }
  const fullName = "박하늘별님구름햇님보다사랑스러우리";
  const nameCell = table.getByRole("cell", { name: fullName, exact: true });
  await expect(nameCell).toHaveAccessibleName(fullName);
  if (font === "serif") expect(await nameCell.evaluate(el => getComputedStyle(el).fontFamily)).toBe("serif");
  await nameCell.hover();
  await expect(nameCell).toHaveAttribute("title", fullName);
  await nameCell.focus();
  await expect(nameCell).toBeFocused();
  await expect(nameCell).toHaveText(fullName);
  await expect(nameCell).toHaveAttribute("title", fullName);
  if (width === 390) expect(await nameCell.evaluate(el => el.scrollWidth > el.clientWidth), "the long name exercises truncation").toBe(true);
  await expectAxe(page, `2,000 unknown weekly rows ${width}`, {
    include: ".page > header, .page > section > div:first-child, .page [data-placement], .page table caption, .page table thead, .page table tbody tr:nth-child(-n+3)",
  });
  await fits(page, `2,000 unknown weekly rows ${width}`);
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
