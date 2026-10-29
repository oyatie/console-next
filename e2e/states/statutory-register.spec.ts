// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { AT, id, user } from "../mock/fixtures";
import { mockRoute } from "../mock/route";
import { mockScreen } from "../mock/screen";
import { screens } from "./registry";
import { expectAxe } from "../a11y";

for (const width of [1440, 390]) test(`the register renders the server's classified masks at ${width}px`, async ({ page }) => {
  const fixture = await mockScreen(page, screens[2], "populated");
  await page.setViewportSize({ width, height: 1000 });
  await mockRoute(page, "get", "/api/v1/access/me", { status: 200, json: { account_id: user.id, is_ops: true, phase: "OPERATING", as_of: AT, entries: [] } });
  await mockRoute(page, "get", "/api/v1/statutory/workplaces", { status: 200, json: [{ id: id(4), name: "본사", entity_name: "검증회사" }] });
  await mockRoute(page, "get", "/api/v1/statutory/worker-register", { status: 200, json: {
    as_of: "2026-09-02", workplace_id: id(4), workplace_name: "본사", total: 1, next: null,
    headers: ["사번", "성명", "성별", "생년월일", "주소", "전화번호"],
    items: [{ employee_id: id(100), cells: ["MASK-1", "김명부", "", "••••-••-••", "", "010-••••-5821"], missing: ["address"] }],
  } });
  await page.goto(`/statutory?tab=register&site=${id(4)}&date=2026-09-02`);
  const table = page.getByRole("table", { name: "근로자 명부" });
  await expect(table).toContainText("••••-••-••");
  await expect(table).toContainText("010-••••-5821");
  await expect(table.getByRole("link", { name: "김명부", exact: true })).toHaveAttribute("href", `/people/${id(100)}`);
  await expect(table.getByRole("cell", { name: "—", exact: true })).toHaveCount(2);
  await expectAxe(page, "masked worker register");
  expect(fixture.unexpected).toEqual([]);
});
