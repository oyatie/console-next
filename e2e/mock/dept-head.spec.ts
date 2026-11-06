// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { go } from "../flows";
import { mockRoute } from "./route";
import { mockScreen } from "./screen";
import { AT, employees, id, structure } from "./fixtures";
import { screens } from "../states/registry";
import { expectAccessible, fits } from "../a11y";
import { forgetResize, recordShifts } from "../stability";

test("operating list and panel appoint directly, keep the code, and refresh the shared vacancy count", async ({ page }) => {
  await page.addInitScript(recordShifts);
  const fixture = await mockScreen(page, screens[2], "populated");
  const tree = structure(3);
  tree.entities[0]!.children[0]!.children[2]!.head = { employee_id: id(102), name: "박부서장", concurrent: false, since: "2026-01-01" };
  const dept = tree.entities[0]!.children[0]!.children[0]!;
  dept.code = "QA-1";
  dept.version = 7;
  await mockRoute(page, "get", "/api/v1/org-structure", () => ({ status: 200, json: tree }));
  await mockRoute(page, "get", "/api/v1/org-units/{id}", { status: 200, json: {
    id: dept.id, kind: "DEPARTMENT", name: dept.name, parentId: id(4), status: "ACTIVE", effectiveFrom: "2026-01-01", headcount: 1, updatedAt: AT, revisions: [], members: { headcount: 0, items: [] },
  } });
  await mockRoute(page, "get", "/api/v1/org-structure/units/{orgUnitId}/members", request => ({ status: 200, json: request.url().includes(dept.id) ? {
    headcount: 3, items: [
      { employeeId: id(100), name: "김부서장", title: "팀장", position: "차장", since: "2026-03-02" },
      { employeeId: id(101), name: "박설정" },
      { employeeId: id(102), name: "Konstantinopapadopoulos", title: "수석연구원겸기술전략팀장", position: "책임연구원", since: "2026-03-02", employeeNumber: "E-000123" },
    ],
  } : { headcount: 0, items: [] } }));
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
  await go(page, "/org?view=list");
  const filter = page.getByRole("button", { name: "부서장 없음 2", exact: true });
  await filter.click();
  await expect(filter).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("grid")).toHaveAttribute("aria-rowcount", "5");
  await expect(page.getByRole("row").filter({ hasText: "검증부서 3" })).toHaveCount(0);
  const row = page.getByRole("row").filter({ hasText: "검증부서 1" });
  const open = row.getByRole("button", { name: "부서장 지정", exact: true });
  const sheet = page.getByRole("dialog", { name: "부서장 지정", exact: true });
  const picker = sheet.getByRole("combobox", { name: "부서장", exact: true });
  await open.focus();
  await open.press("Enter");
  await expect(picker).toBeFocused();
  await expect(row).not.toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("button", { name: "선택 해제", exact: true })).toHaveCount(0);
  await sheet.getByRole("button", { name: "닫기", exact: true }).click();
  await expect(open).toBeFocused();
  await open.press("Space");
  await expect(picker).toBeFocused();
  await expect(row).not.toHaveAttribute("aria-selected", "true");
  await sheet.getByRole("button", { name: "닫기", exact: true }).click();
  await open.click();
  await expect(picker).toBeFocused();
  await expect(page).toHaveURL(/view=list.*act=dept-head/);
  await picker.press("ArrowDown");
  await page.getByRole("option", { name: /김부서장/ }).click();
  await page.evaluate(() => {
    const filter = document.getElementById("registry-vacant")!;
    filter.dataset.focusReturns = "0";
    filter.addEventListener("focus", () => { filter.dataset.focusReturns = String(Number(filter.dataset.focusReturns) + 1); });
  });
  await sheet.getByRole("button", { name: "부서장 지정", exact: true }).click();
  await expect(sheet).toBeHidden();
  await expect(page.getByRole("button", { name: "선택 해제", exact: true })).toHaveCount(0);
  expect(saved).toBe(true);
  const remaining = page.getByRole("button", { name: "부서장 없음 1", exact: true });
  await expect(remaining).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("grid")).toHaveAttribute("aria-rowcount", "4");
  await expect(remaining).toBeFocused();
  // A transient focus hit must not pass before the grid's pending focus effect runs.
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(remaining).toBeFocused();
  await expect(remaining).toHaveAttribute("data-focus-returns", "1");
  await remaining.click();
  await expect(page.getByRole("grid")).toContainText("김부서장");
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await forgetResize(page);
    const targets = await page.locator('[role="gridcell"], [role="rowheader"]').filter({ has: page.getByRole("button") }).evaluateAll(cells => cells.map(cell => ({
      tabIndex: cell.getAttribute("tabindex"),
      buttons: Array.from(cell.querySelectorAll("button"), button => ({ width: button.getBoundingClientRect().width, height: button.getBoundingClientRect().height })),
    })));
    for (const cell of targets) {
      expect(cell.tabIndex).toBe("-1");
      for (const button of cell.buttons) {
        expect(button.width).toBeGreaterThanOrEqual(24);
        expect(button.height).toBeGreaterThanOrEqual(24);
      }
    }
    if (width === 1440) {
      const appoint = page.getByRole("row").filter({ hasText: "검증부서 2" }).getByRole("button", { name: "부서장 지정", exact: true });
      const head = page.getByRole("columnheader", { name: "부서장", exact: true });
      const filled = page.getByRole("gridcell", { name: "박부서장", exact: true });
      const inset = await filled.evaluate(cell => parseFloat(getComputedStyle(cell).paddingInlineStart));
      expect((await appoint.boundingBox())!.x).toBeCloseTo((await head.boundingBox())!.x + inset, 0);
      expect((await filled.boundingBox())!.x).toBeCloseTo((await head.boundingBox())!.x, 0);
    }
    if (width === 390) await fits(page, "department list");
    await expectAccessible(page, `department list ${width}`);
  }
  // Member rows wrap as a whole at 390 px: no row overflows and the date and 사번 each stay one unit.
  await page.setViewportSize({ width: 390, height: 900 });
  await go(page, `/org?sel=${dept.id}`);
  const longRow = page.getByRole("listitem").filter({ hasText: "Konstantinopapadopoulos" });
  await expect(longRow).toHaveCount(1);
  expect(await longRow.evaluate(li => li.scrollWidth <= li.clientWidth)).toBe(true);
  await expect(longRow.getByText("E-000123", { exact: true })).toBeVisible();
  expect(await longRow.getByText("E-000123", { exact: true }).evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.setViewportSize({ width: 1440, height: 900 });
  await Promise.all([
    page.waitForResponse(response => new URL(response.url()).pathname === `/api/v1/org-units/${id(101)}`),
    go(page, `/org?sel=${id(101)}`),
  ]);
  const panel = page.getByRole("complementary", { name: "검증부서 2", exact: true });
  await expect(panel.getByText("부서장 없음", { exact: true })).toHaveCount(1);
  await panel.getByRole("button", { name: "부서장 지정", exact: true }).click();
  await expect(picker).toBeFocused();
  await sheet.getByRole("button", { name: "닫기", exact: true }).click();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await forgetResize(page);
    if (width === 390) await fits(page, "department panel");
    await expectAccessible(page, `department panel ${width}`);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await go(page, `/org?sel=${dept.id}`);
  const members = page.locator("#dept-members");
  const head = members.getByRole("listitem").filter({ hasText: "김부서장" });
  await expect(head).toContainText("팀장 · 차장 · 2026. 03. 02.부터");
  await expect(head.getByText("부서장", { exact: true })).toBeVisible();
  const undated = members.getByRole("listitem").filter({ hasText: "박설정" });
  await expect(undated).not.toContainText("부터");
  await expect(undated.getByText("부서장", { exact: true })).toHaveCount(0);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await forgetResize(page);
    if (width === 390) await fits(page, "department member dates");
    await expectAccessible(page, `department member dates ${width}`);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await go(page, `/org?view=list&sel=${dept.id}`);
  const other = page.getByRole("row").filter({ hasText: "검증부서 2" });
  await other.getByRole("button", { name: "부서장 지정", exact: true }).click();
  await expect(picker).toBeFocused();
  await expect(other).not.toHaveAttribute("aria-selected", "true");
  await expect(row).toHaveAttribute("aria-selected", "true");
  await sheet.getByRole("button", { name: "닫기", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`sel=${dept.id}$`));
  expect(fixture.unexpected).toEqual([]);
});

test("a historical department offers no appointment, including a direct action URL", async ({ page }) => {
  await mockScreen(page, screens[2], "populated");
  await mockRoute(page, "get", "/api/v1/org-structure", { status: 200, json: { ...structure(2), read_only: true, as_of: "2026-01-01" } });
  await go(page, `/org?view=list&sel=${id(100)}&act=dept-head&as_of=2026-01-01`);
  await expect(page.getByRole("button", { name: "부서장 없음 2", exact: true })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "부서장 지정", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "부서장 지정", exact: true })).toHaveCount(0);
});

for (const width of [1440, 390]) for (const theme of ["light", "dark"]) {
  test(`list arrows leave the name chevron and head action at ${width}px in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const fixture = await mockScreen(page, screens[2], "populated");
    await mockRoute(page, "get", "/api/v1/org-structure", { status: 200, json: structure(3) });
    await go(page, "/org?view=list");
    await page.locator("html").evaluate((el, value) => { el.dataset.theme = value; }, theme);
    const grid = page.getByRole("grid");
    const chevron = grid.getByRole("button", { name: "본사 접기", exact: true });
    const head = page.getByRole("row").filter({ hasText: "검증부서 2" }).getByRole("button", { name: "부서장 지정", exact: true });
    for (const control of [chevron, head]) {
      await expect(control).toBeVisible();
      if (control === chevron) {
        await control.locator('xpath=ancestor::*[@role="rowheader"][1]').focus();
        await expect(control).toBeFocused();
      }
      for (const key of ["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"]) {
        await control.focus();
        await page.keyboard.press(key);
        await expect(control).not.toBeFocused();
      }
      const box = await control.boundingBox();
      expect(box!.width).toBeGreaterThanOrEqual(24);
      expect(box!.height).toBeGreaterThanOrEqual(24);
      await control.focus();
      await page.keyboard.press("Tab");
      await expect(control).not.toBeFocused();
    }
    await grid.evaluate(el => {
      const after = document.createElement("button");
      after.id = "after-table";
      after.textContent = "다음";
      after.className = "btn";
      el.closest("section")!.after(after);
    });
    await head.focus();
    const tabStops = await grid.locator("button, input, a[href], [tabindex]").count();
    for (let step = 0; step <= tabStops && await grid.evaluate(el => el.contains(document.activeElement)); step++) await page.keyboard.press("Tab");
    await expect(page.locator("#after-table")).toBeFocused();
    // Every rendered cell and its controls participate in vertical navigation.
    const row = page.getByRole("row").filter({ hasText: "검증부서 2" });
    const next = page.getByRole("row").filter({ hasText: "검증부서 3" });
    for (const cell of await row.locator('[role="rowheader"], [role="gridcell"]').all()) {
      await cell.focus();
      await page.keyboard.press("ArrowDown");
      await expect.poll(() => next.evaluate(el => el.contains(document.activeElement))).toBe(true);
      await page.keyboard.press("ArrowUp");
      await expect.poll(() => cell.evaluate(el => el.contains(document.activeElement))).toBe(true);
    }
    await head.focus();
    await page.keyboard.press("Enter");
    const sheet = page.getByRole("dialog", { name: "부서장 지정", exact: true });
    await expect(sheet.getByRole("combobox", { name: "부서장", exact: true })).toBeFocused();
    await sheet.getByRole("button", { name: "닫기", exact: true }).click();
    await expect(head).toBeFocused();
    await fits(page, `department arrows ${width} ${theme}`);
    await expectAccessible(page, `department arrows ${width} ${theme}`);
    expect(fixture.unexpected).toEqual([]);
  });
}

for (const width of [1440, 390]) test(`keyboard appointment adopts the pressed cell at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  const fixture = await mockScreen(page, screens[2], "populated");
  await mockRoute(page, "get", "/api/v1/org-structure", { status: 200, json: structure(3) });
  await go(page, "/org?view=list");
  const rows = page.getByRole("row").filter({ has: page.getByRole("rowheader") });
  await rows.first().focus();
  await page.locator("body").evaluate(el => { el.tabIndex = -1; el.focus(); });
  await page.keyboard.press("ArrowRight");
  const open = rows.filter({ hasText: "검증부서 2" }).getByRole("button", { name: "부서장 지정", exact: true });
  await open.focus();
  await page.keyboard.press("Enter");
  const sheet = page.getByRole("dialog", { name: "부서장 지정", exact: true });
  await expect(sheet.getByRole("combobox", { name: "부서장", exact: true })).toBeFocused();
  await sheet.getByRole("button", { name: "닫기", exact: true }).click();
  await expect(open).toBeFocused();
  expect(fixture.unexpected).toEqual([]);
});

for (const width of [1440, 390]) test(`list boundary keys and order and add targets at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  const fixture = await mockScreen(page, screens[2], "populated");
  const tree = structure(3);
  tree.phase = "SETUP";
  await mockRoute(page, "get", "/api/v1/org-structure", { status: 200, json: tree });
  await go(page, "/org?view=list");
  const grid = page.getByRole("grid");
  const row = page.getByRole("row").filter({ hasText: "검증부서 2" });
  const head = row.getByRole("button", { name: "부서장 지정", exact: true });
  await expect(head).toBeVisible();
  for (const key of ["Home", "End", "PageUp", "PageDown"]) {
    // Paging virtualizes the origin out; bring it back before the next independent key.
    if (width === 390) await grid.evaluate(el => { el.scrollTop = el.scrollHeight; });
    await head.focus();
    const startIndex = Number(await row.getAttribute("aria-rowindex"));
    await page.keyboard.press(key);
    const destination = page.getByRole("row").filter({ hasText: "검증부서 3" });
    if (key === "PageDown") await expect.poll(() => destination.evaluate(el => el.contains(document.activeElement))).toBe(true);
    else if (key === "PageUp") await expect.poll(() => page.evaluate(() => Number(document.activeElement?.closest('[role="row"]')?.getAttribute("aria-rowindex")))).toBeLessThan(startIndex);
    else if (width === 1440 || key === "Home") await expect(head).not.toBeFocused();
  }
  if (width === 1440) {
    // Arrive with arrows so the roving cell, rather than a non-roving tabindex, is measured.
    for (const [header, label] of [["순서", "검증부서 2 위로"], ["작업", "검증부서 2 이름 변경"]]) {
      const column = await grid.getByRole("columnheader", { name: header, exact: true }).getAttribute("aria-colindex");
      const cell = row.locator(`[aria-colindex="${column}"]`);
      await row.getByRole("rowheader").focus();
      for (let step = 0; step < Number(column) * 2 && !await cell.evaluate(el => el.contains(document.activeElement)); step++) await page.keyboard.press("ArrowRight");
      const control = cell.getByRole("button", { name: label, exact: true });
      await expect(control).toBeFocused();
      await expect(cell).toHaveAttribute("tabindex", "-1");
      const box = await control.boundingBox();
      expect(box!.width).toBeGreaterThanOrEqual(24);
      expect(box!.height).toBeGreaterThanOrEqual(24);
    }
  }
  await fits(page, `department navigation ${width}`);
  expect(fixture.unexpected).toEqual([]);
});
