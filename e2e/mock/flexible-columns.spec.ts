// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test, type Page } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { expectAxe, fits } from "../a11y";
import { employees, id } from "./fixtures";
import { mockLifecycleSheets, moveDetail } from "./lifecycle-sheets";
import { mockRoute } from "./route";
import { mockScreen } from "./screen";
import { lifecycleSheetScreens } from "../states/lifecycle-sheets";
import { screens } from "../states/registry";

test.beforeAll(() => loadCatalog("ko"));

async function setupRoster(page: Page) {
  const fixture = await mockScreen(page, screens[1], "populated");
  await mockLifecycleSheets(page, lifecycleSheetScreens[0]);
  const listRows = employees(3);
  await mockRoute(page, "get", "/api/v1/employees/{id}", request => {
    const empId = new URL(request.url()).pathname.split("/").pop()!;
    const found = listRows.find(row => row.id === empId) ?? listRows[0]!;
    return {
      status: 200,
      json: {
        ...moveDetail,
        employee: { ...moveDetail.employee, id: found.id, name: found.name, employee_number: found.employee_number, org_unit_id: id(4003), org_unit: "인사팀" },
      },
    };
  });
  await mockRoute(page, "get", "/api/v1/org-structure/units/{orgUnitId}/members", {
    status: 200,
    json: {
      headcount: 2,
      items: [
        { employeeId: id(100), name: "검증직원 1", employeeNumber: "UI-0001", title: "매니저", position: "인사", since: "2026-01-01" },
        { employeeId: id(101), name: "검증직원 2", employeeNumber: "UI-0002", title: "선임", position: "인사", since: "2026-02-01" },
      ],
    },
  });
  return fixture;
}

test("people roster proves flexible 3-column layout, URL ?sel=/&sel2= reload, J/K + arrows + / + Enter + Esc, and drag-resize", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const fixture = await setupRoster(page);
  await page.goto("/people");
  const grid = page.getByRole("grid", { name: t("people.table"), exact: true });
  await expect(grid).toBeVisible();

  await grid.getByText("UI-0001", { exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`sel=${id(100)}`));
  const record = page.getByRole("complementary", { name: t("people.panel"), exact: true });
  await expect(record.getByRole("heading", { level: 2, name: /검증직원 1/ })).toBeVisible();
  await expect(record).toContainText(t("common.denied.panel"));
  await expect(record).not.toContainText(t("common.denied.title.plain"));

  const gridBox = (await grid.boundingBox())!;
  const recBox = (await record.boundingBox())!;
  expect(gridBox.x + gridBox.width).toBeLessThanOrEqual(recBox.x + 1);

  // J/K and ArrowDown/ArrowUp move the list while the record column follows.
  await page.keyboard.press("j");
  await expect(page).toHaveURL(new RegExp(`sel=${id(101)}`));
  await expect(record.getByRole("heading", { level: 2, name: /검증직원 2/ })).toBeVisible();
  await page.keyboard.press("k");
  await expect(page).toHaveURL(new RegExp(`sel=${id(100)}`));
  await expect(record.getByRole("heading", { level: 2, name: /검증직원 1/ })).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await expect(page).toHaveURL(new RegExp(`sel=${id(101)}`));
  await expect(record.getByRole("heading", { level: 2, name: /검증직원 2/ })).toBeVisible();

  // Open optional 3rd related-record column (?sel2=) from placement button.
  const placeBtn = record.getByRole("button", { name: /인사팀/ });
  await placeBtn.click();
  await expect(page).toHaveURL(new RegExp(`sel=${id(101)}.*sel2=${id(4003)}|sel2=${id(4003)}.*sel=${id(101)}`));
  const related = page.getByRole("complementary", { name: t("roster.panel.unit"), exact: true });
  await expect(related).toBeVisible();
  await expect(related.getByRole("heading", { level: 2, name: "인사팀", exact: true })).toBeVisible();
  await expect(related.getByRole("link", { name: t("roster.panel.openOrg"), exact: true })).toHaveAttribute("href", new RegExp(`/org\\?.*sel=${id(4003)}`));

  // Reload preserves both ?sel= and ?sel2=.
  await page.reload();
  await expect(grid).toBeVisible({ timeout: 15_000 });
  await expect(record.getByRole("heading", { level: 2, name: /검증직원 2/ })).toBeVisible();
  await expect(related.getByRole("heading", { level: 2, name: "인사팀", exact: true })).toBeVisible();

  // Drag-resize changes column width.
  const splitter = page.getByRole("separator", { name: t("common.resizeColumn") }).first();
  const beforeWidth = (await record.boundingBox())!.width;
  const sBox = (await splitter.boundingBox())!;
  await page.mouse.move(sBox.x + sBox.width / 2, sBox.y + sBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(sBox.x - 50, sBox.y + sBox.height / 2);
  await page.mouse.up();
  expect((await record.boundingBox())!.width).toBeGreaterThan(beforeWidth + 30);

  // '/' inside open columns focuses roster search.
  await related.getByRole("link", { name: t("roster.panel.openOrg"), exact: true }).focus();
  await page.keyboard.press("/");
  await expect(page.getByRole("searchbox", { name: t("roster.find") })).toBeFocused();

  // Full screen is shareable; Escape restores before closing the selected unit.
  const full = related.getByRole("button", { name: t("uiFlexibleColumns.full"), exact: true });
  await full.click();
  await expect(page).toHaveURL(/full=1/);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(full).toHaveAttribute("aria-pressed", "true");
  await expect(page).toHaveURL(new RegExp(`sel=${id(101)}`));
  await expect(page).toHaveURL(new RegExp(`sel2=${id(4003)}`));
  await expect(grid).toBeHidden();
  await expect(record).toBeHidden();
  await full.focus();
  await page.keyboard.press("Escape");
  await expect(page).not.toHaveURL(/full=/);
  await expect(full).toHaveAttribute("aria-pressed", "false");
  await expect(full).toBeFocused();
  await expect(grid).toBeVisible();

  // Esc closes rightmost column first (?sel2=), then second Esc closes ?sel= and restores row focus.
  await related.getByRole("link", { name: t("roster.panel.openOrg"), exact: true }).focus();
  await page.keyboard.press("Escape");
  await expect(related).toHaveCount(0);
  await expect(page).not.toHaveURL(/sel2=/);
  await expect(page).toHaveURL(new RegExp(`sel=${id(101)}`));
  await expect(placeBtn).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(record).toHaveCount(0);
  await expect(page).not.toHaveURL(/sel=/);
  const row2 = grid.locator(`[role="row"][data-row-id="${id(101)}"]`);
  await expect(row2).toBeFocused();

  // Enter opens preview, second Enter opens full personnel card.
  await page.keyboard.press("Enter");
  await expect(record).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/people/${id(101)}$`));
  expect(fixture.unexpected).toEqual([]);
});

for (const width of [1440, 390]) for (const theme of ["light", "dark"] as const) {
  test(`people roster 3-column and single-column + Back fit ${width}px in ${theme} @ui-state`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(value => localStorage.setItem("console.theme", value), theme);
    const fixture = await setupRoster(page);
    await page.goto(`/people?sel=${id(100)}&sel2=${id(4003)}`);

    const grid = page.getByRole("grid", { name: t("people.table"), exact: true });
    const record = page.getByRole("complementary", { name: t("people.panel"), exact: true });
    const related = page.getByRole("complementary", { name: t("roster.panel.unit"), exact: true });
    await expect(related).toBeVisible({ timeout: 15_000 });

    await page.screenshot({ path: testInfo.outputPath(`${width}-${theme}-columns.png`), fullPage: true });
    const full = related.getByRole("button", { name: t("uiFlexibleColumns.full"), exact: true });
    if (width === 1440) {
      await full.click();
      await expect(full).toHaveAttribute("aria-pressed", "true");
      await expect(grid).toBeHidden();
      await expect(record).toBeHidden();
      await fits(page, `people full ${width} ${theme}`);
      await page.screenshot({ path: testInfo.outputPath(`${width}-${theme}-full.png`), fullPage: true });
      await full.press("Escape");
      await expect(full).toHaveAttribute("aria-pressed", "false");
      await expect(full).toBeFocused();
    } else {
      await expect(full).toHaveCount(0);
      await page.goto(`/people?sel=${id(100)}&sel2=${id(4003)}&full=1`);
      await expect(related).toBeVisible();
      await expect(full).toHaveCount(0);
      await fits(page, `people full ${width} ${theme}`);
      await page.screenshot({ path: testInfo.outputPath(`${width}-${theme}-full.png`), fullPage: true });
    }
    await page.screenshot({ path: testInfo.outputPath(`${width}-${theme}-restored.png`), fullPage: true });

    if (width === 1440) {
      await expect(grid).toBeVisible();
      await expect(record).toBeVisible();
      const g = (await grid.boundingBox())!;
      const r1 = (await record.boundingBox())!;
      const r2 = (await related.boundingBox())!;
      expect(g.x + g.width).toBeLessThanOrEqual(r1.x + 1);
      expect(r1.x + r1.width).toBeLessThanOrEqual(r2.x + 1);
    } else {
      await expect(grid).toBeHidden();
      await expect(record).toBeHidden();
      await fits(page, `people related 390 ${theme}`);
      if (theme === "light") await expectAxe(page, "people related 390");
      await related.getByRole("button", { name: t("common.back"), exact: true }).click();
      await expect(related).toHaveCount(0);
      await expect(record).toBeVisible();
      await expect(grid).toBeHidden();
      await fits(page, `people record 390 ${theme}`);
      if (theme === "light") await expectAxe(page, "people record 390");
      await record.getByRole("button", { name: t("common.back"), exact: true }).click();
      await expect(record).toHaveCount(0);
      await expect(grid).toBeVisible();
    }
    await fits(page, `people columns ${width} ${theme}`);
    if (theme === "light") await expectAxe(page, `people columns ${width}`);
    expect(fixture.unexpected).toEqual([]);
  });
}

for (const theme of ["light", "dark"] as const) {
  test(`/_gallery showcases header needs-me badge and task panel in ${theme} @ui-state`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.addInitScript(value => localStorage.setItem("console.theme", value), theme);
    await page.route(url => url.pathname.startsWith("/api/"), route => route.fulfill({ status: 503, json: { error: { code: "service_unavailable", message: "unavailable" } } }));
    await page.goto("/_gallery");
    const dock = page.getByRole("complementary", { name: "26칸 저장", exact: true }).or(page.getByRole("dialog", { name: "26칸 저장", exact: true }));
    await dock.getByRole("button", { name: "돌아가기", exact: true }).click();
    await expect(dock).toHaveCount(0);

    const examples = page.getByRole("heading", { name: t("uiFlexibleColumns.full"), exact: true }).locator("..");
    await expect(examples.getByRole("button", { name: t("uiFlexibleColumns.full"), pressed: true, exact: true })).toHaveCount(1);
    await expect(examples.getByRole("button", { name: t("uiFlexibleColumns.full"), pressed: false, exact: true })).toHaveCount(1);

    const trigger = page.locator("#gallery-needs-me-OPERATING");
    await expect(trigger).toHaveAccessibleName(t("shell.needsMe.count", { count: 3 }));
    await trigger.click();
    const panel = page.getByRole("dialog", { name: t("shell.needsMe"), exact: true });
    await expect(panel).toBeVisible();
    await expect(panel.getByRole("link", { name: t("home.inbox.viewInbox"), exact: true })).toHaveAttribute("href", "/inbox");
    if (theme === "light") {
      await expectAxe(page, "gallery needs-me trigger", { include: "#gallery-needs-me-OPERATING" });
      await expectAxe(page, "gallery needs-me panel", { include: '[role="dialog"]' });
    }
    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);
  });
}
