// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { mockRoute } from "./route";
import { mockScreen } from "./screen";
import { AT, employees, id, structure } from "./fixtures";
import { screens } from "../states/registry";
import { expectAccessible } from "../a11y";
import { forgetResize, recordShifts } from "../stability";

test("operating list and panel appoint directly, keep the code, and refresh the shared vacancy count", async ({ page }) => {
  await page.addInitScript(recordShifts);
  const fixture = await mockScreen(page, screens[2], "populated");
  const tree = structure(2);
  const dept = tree.entities[0]!.children[0]!.children[0]!;
  dept.code = "QA-1";
  dept.version = 7;
  await mockRoute(page, "get", "/api/v1/org-structure", () => ({ status: 200, json: tree }));
  await mockRoute(page, "get", "/api/v1/org-units/{id}", { status: 200, json: {
    id: dept.id, kind: "DEPARTMENT", name: dept.name, parentId: id(4), status: "ACTIVE", effectiveFrom: "2026-01-01", headcount: 1, updatedAt: AT, revisions: [], members: { headcount: 0, items: [] },
  } });
  await mockRoute(page, "get", "/api/v1/org-structure/units/{orgUnitId}/members", { status: 200, json: { headcount: 0, items: [] } });
  await mockRoute(page, "get", "/api/v1/org-structure/units/{orgUnitId}/end-options", { status: 200, json: { org_unit_id: id(101), name: "검증부서 2", version: 1, phase: "OPERATING", delete: { allowed: true }, dissolve: { allowed: true }, members: 0, people_ever: 0, units: 0, can_manage: true } });
  await mockRoute(page, "get", "/api/v1/employees", { status: 200, json: { items: employees(1).map(p => ({ ...p, org_unit_id: dept.id, name: "김부서장" })), total: 1, limit: 20, offset: 0, next_cursor: null } });
  let saved = false;
  await mockRoute(page, "put", "/api/v1/org-structure/units/{orgUnitId}/details", request => {
    expect(request.postDataJSON()).toEqual({ expected_version: 7, code: "QA-1", head_employee_id: id(100) });
    expect(request.headers()["idempotency-key"]).toBeTruthy();
    dept.head = { employee_id: id(100), name: "김부서장", concurrent: false, since: "2026-10-26" };
    dept.version = 8;
    saved = true;
    return { status: 200, json: { id: dept.id, version: 8, batch_id: id(9), change_mode: "GOVERNED" } };
  });
  await page.goto("/org?view=list");
  const filter = page.getByRole("button", { name: "부서장 없음 2", exact: true });
  await filter.click();
  const row = page.getByRole("row").filter({ hasText: "검증부서 1" });
  const open = row.getByRole("button", { name: "부서장 지정", exact: true });
  const sheet = page.getByRole("dialog", { name: "부서장 지정", exact: true });
  const picker = sheet.getByRole("combobox", { name: "부서장", exact: true });
  await open.focus();
  await open.press("Enter");
  await expect(picker).toBeFocused();
  await sheet.getByRole("button", { name: "닫기", exact: true }).click();
  await expect(open).toBeFocused();
  await open.click();
  await expect(picker).toBeFocused();
  await expect(page).toHaveURL(/view=list.*act=dept-head/);
  await picker.press("ArrowDown");
  await page.getByRole("option", { name: /김부서장/ }).click();
  await sheet.getByRole("button", { name: "부서 정보 1개 변경", exact: true }).click();
  await expect(sheet).toBeHidden();
  expect(saved).toBe(true);
  const remaining = page.getByRole("button", { name: "부서장 없음 1", exact: true });
  await expect(remaining).toHaveAttribute("aria-pressed", "true");
  await expect(remaining).toBeFocused();
  await remaining.click();
  await expect(page.getByRole("grid")).toContainText("김부서장");
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await forgetResize(page);
    await expectAccessible(page, `department list ${width}`);
  }
  await page.goto(`/org?sel=${id(101)}`);
  const panel = page.getByRole("complementary", { name: "검증부서 2", exact: true });
  await expect(panel.getByText("부서장 없음", { exact: true })).toHaveCount(1);
  await panel.getByRole("button", { name: "부서장 지정", exact: true }).click();
  await expect(picker).toBeFocused();
  await sheet.getByRole("button", { name: "닫기", exact: true }).click();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await forgetResize(page);
    await expectAccessible(page, `department panel ${width}`);
  }
  expect(fixture.unexpected).toEqual([]);
});

test("a historical department offers no appointment, including a direct action URL", async ({ page }) => {
  await mockScreen(page, screens[2], "populated");
  await mockRoute(page, "get", "/api/v1/org-structure", { status: 200, json: { ...structure(2), read_only: true, as_of: "2026-01-01" } });
  await page.goto(`/org?view=list&sel=${id(100)}&act=dept-head&as_of=2026-01-01`);
  await expect(page.getByRole("button", { name: "부서장 없음 2", exact: true })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "부서장 지정", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "부서장 지정", exact: true })).toHaveCount(0);
});
