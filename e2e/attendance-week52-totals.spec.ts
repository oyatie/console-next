// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { chooseRadio, go, kstDate, registerEmployee } from "./flows";
import { apiOf, bearerOf } from "./helpers/api";
import { cellOf, officeSchedule, openMonth, pastWorkDay } from "./helpers/attendance-records";
import { staffedTenant } from "./setup-flows";
import { expectAxe, fits } from "./a11y";
import { addDays, nextMonday } from "../apps/web/src/ui/date/days";

test("weekly totals render stored scheduled work and keep unknown values distinct from zero", { tag: ["@hr", "@regression"] }, async ({ browser }, info) => {
  test.setTimeout(600_000);
  const { admin } = await staffedTenant(browser, "weeklytotals", "주간근로시간");
  const bearer = bearerOf(admin);
  await registerEmployee(admin, { name: "윤하준", number: "W-01", hired: kstDate(-60) });
  await registerEmployee(admin, { name: "황정우", number: "W-02", hired: kstDate(-60) });
  await officeSchedule(admin);
  const api = apiOf(admin, bearer);
  const peopleResponse = await api("/employees?limit=10");
  expect(peopleResponse.status(), await peopleResponse.text()).toBe(200);
  const people = await peopleResponse.json() as { items: { id: string; name: string }[] };
  const employee = people.items.find(p => p.name === "윤하준")!.id;
  const { month, date } = await pastWorkDay(api, employee);
  const monthGrid = await openMonth(admin, month);
  await cellOf(admin, "윤하준", date).click();
  await admin.keyboard.type("9-20");
  await admin.keyboard.press("Enter");
  await monthGrid.focus();
  await admin.keyboard.press("ControlOrMeta+s");
  const save = admin.getByRole("complementary", { name: /저장 · 초안 1칸/ });
  await chooseRadio(save, /출근부 \(종이\)/);
  await save.getByRole("button", { name: "1칸 저장", exact: true }).click();
  await expect(admin.getByRole("status").filter({ hasText: "1칸을 저장했습니다" })).toBeVisible();
  const recorded = await api(`/attendance/people/${employee}/month?month=${month}`);
  expect(recorded.status(), await recorded.text()).toBe(200);
  const day = (await recorded.json()).days.find((d: { date: string }) => d.date === date);
  expect(day.recognition).toMatchObject({ recognised: 600, outside_scheduled: 120 });
  const response = await api(`/attendance/week52?week_start=${addDays(nextMonday(date), -7)}`);
  expect(response.status(), await response.text()).toBe(200);
  const board = await response.json();
  expect(board.items.find((r: {employee_id: string}) => r.employee_id === employee)).toMatchObject({ recognized_hours: 10, overtime_hours: 2 });
  expect(board.items.find((r: {name: string}) => r.name === "황정우")).toMatchObject({ recognized_hours: null, overtime_hours: null });
  const weeklyRead = admin.waitForResponse(r => new URL(r.url()).pathname === "/api/v1/attendance/week52" && r.request().method() === "GET");
  await go(admin, `/attendance?tab=week&date=${date}`);
  const shown = await weeklyRead;
  expect(shown.status(), await shown.text()).toBe(200);
  for (const width of [1440, 390]) for (const colorScheme of ["light", "dark"] as const) {
    await admin.setViewportSize({ width, height: 900 });
    await admin.locator("html").evaluate((el, theme) => { el.dataset.theme = theme; }, colorScheme);
    const grid = admin.getByRole("grid", { name: "연장근로", exact: true });
    await expect(grid.getByRole("row").filter({ hasText: "윤하준" })).toContainText("10시간");
    await expect(grid.getByRole("row").filter({ hasText: "황정우" }).getByText("미제공", { exact: true })).toHaveCount(2);
    await info.attach(`weekly-${width}-${colorScheme}`, { body: await admin.screenshot({ fullPage: true }), contentType: "image/png" });
    await fits(admin, `weekly totals ${width} ${colorScheme}`);
    await expectAxe(admin, `weekly totals ${width} ${colorScheme}`);
  }
});
