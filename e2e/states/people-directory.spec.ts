// SPDX-License-Identifier: LicenseRef-Proprietary
import { loadCatalog, t } from "@console/i18n";
import { expect, test, type Page } from "@playwright/test";
import { expectAxe, fits } from "../a11y";
import { employees, facets } from "../mock/fixtures";
import { mockRoute } from "../mock/route";
import { mockScreen } from "../mock/screen";
import { screens } from "./registry";

test.beforeAll(() => loadCatalog("ko"));

async function directory(page: Page, holdSort = false) {
  const fixture = await mockScreen(page, screens[1], "large");
  const rows = employees(fixture.count);
  const requests: URLSearchParams[] = [];
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await mockRoute(page, "get", "/api/v1/employees", async request => {
    const query = new URL(request.url()).searchParams;
    requests.push(query);
    const reviewed = query.has("contract_ending_before") || query.has("register_review_required");
    const matching = query.has("search") ? [] : reviewed ? rows.slice(-250) : rows;
    if (reviewed || (holdSort && query.get("sort") !== "name")) await held;
    const cursor = query.get("cursor");
    const offset = cursor ? matching.findIndex(row => row.id === cursor) + 1 : 0;
    const limit = Number(query.get("limit")), end = offset + limit;
    return { status: 200, json: { items: matching.slice(offset, end), total: matching.length, offset, limit,
      next_cursor: end < matching.length ? matching[end - 1]!.id : null } };
  });
  await mockRoute(page, "get", "/api/v1/employees/facets", request => {
    const query = new URL(request.url()).searchParams;
    const result = facets(query.has("search") ? 0 : query.has("register_review_required") ? 250 : fixture.count);
    return { status: 200, json: { ...result, review: { ...result.review, identity_review_required: 250, register_review_required: 250, contract_ending_before: 250 } } };
  });
  return { ...fixture, requests, release };
}

for (const width of [1440, 390]) for (const theme of ["light", "dark"]) {
  test(`directory filters replace server pages and stay removable ${width} ${theme} @ui-state`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(value => localStorage.setItem("console.theme", value), theme);
    const fixture = await directory(page);
    await page.goto("/people");
    const grid = page.getByRole("grid", { name: t("people.table"), exact: true });
    const foot = page.getByRole("note", { name: t("roster.foot.label") });
    const filters = page.getByRole("group", { name: t("people.filter.label"), exact: true });
    const reset = page.getByRole("button", { name: t("people.filter.reset"), exact: true });
    await expect(foot).toContainText(t("roster.foot.range", { shown: 100, total: fixture.count }));
    await expect(reset).toHaveCount(0);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    expect(await grid.getByRole("row").count()).toBeLessThan(60);
    await grid.evaluate(el => { el.scrollTop = el.scrollHeight; });
    await expect(foot).toContainText(t("roster.foot.range", { shown: 200, total: fixture.count }));
    const firstPageCursor = fixture.requests.find(query => query.has("cursor"))!.get("cursor");
    expect(firstPageCursor).toBeTruthy();

    await page.getByRole("button", { name: t("roster.view.contractSoon"), exact: true }).click();
    await expect.poll(() => fixture.requests.some(query => query.has("contract_ending_before"))).toBe(true);
    const filtered = fixture.requests.find(query => query.has("contract_ending_before"))!;
    expect(filtered.has("cursor")).toBe(false);
    expect(filtered.has("offset")).toBe(false);
    await expect(grid.getByRole("rowheader").filter({ hasText: /UI-\d+/ })).toHaveCount(0);
    await grid.evaluate(el => { el.scrollTop = el.scrollHeight; });
    await expect(grid.getByText(t("uiLongTable.loadingMore"), { exact: true })).toHaveCount(0);
    expect(fixture.requests.filter(query => query.has("contract_ending_before") && query.has("cursor"))).toHaveLength(0);
    const active = filters.getByRole("button", { name: new RegExp(t("roster.review.contractSoon", { days: 60 })) });
    await expect(active).toHaveCount(0);
    await filters.getByRole("button", { name: new RegExp(t("roster.review.identity")) }).click();
    await expect(active).toHaveAttribute("aria-pressed", "true");
    fixture.release();
    await expect(foot).toContainText(t("roster.foot.range", { shown: 100, total: 250 }));
    await fits(page, `active directory filters ${width} ${theme}`);
    await expectAxe(page, `active directory filters ${width} ${theme}`);
    await grid.evaluate(el => { el.scrollTop = el.scrollHeight; });
    await expect(foot).toContainText(t("roster.foot.range", { shown: 200, total: 250 }));
    const next = fixture.requests.find(query => query.has("contract_ending_before") && query.has("cursor"))!;
    expect(next.get("cursor")).not.toBe(firstPageCursor);
    expect(next.get("sort")).toBe("name");
    expect(next.get("contract_ending_before")).toBe(filtered.get("contract_ending_before"));
    expect(next.getAll("status")).toEqual(filtered.getAll("status"));
    expect(next.has("offset")).toBe(false);
    expect(await grid.getByRole("row").count()).toBeLessThan(60);
    await active.focus();
    await active.press("Enter");
    await expect(page).toHaveURL(/review=identity/);
    await expect(active).toHaveCount(0);
    await reset.click();
    await expect(page).not.toHaveURL(/review=/);
    await expect(foot).toContainText(t("roster.foot.range", { shown: 200, total: fixture.count }));

    await page.getByRole("button", { name: t("roster.view.gaps"), exact: true }).click();
    await expect(foot).toContainText(t("roster.foot.range", { shown: 100, total: 250 }));
    await expect(filters.getByRole("button", { name: new RegExp(t("roster.review.register")) })).toHaveCount(0);
    await expect(reset).toHaveCount(1);
    await reset.click();
    await expect(page).not.toHaveURL(/review=/);
    await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
    await expect(reset).toHaveCount(0);

    const find = page.getByRole("searchbox", { name: t("roster.find") });
    await find.fill("없는 직원");
    await find.press("Enter");
    await expect(page.getByText(t("roster.empty.q", { q: "없는 직원" }), { exact: true })).toBeVisible();
    await expect(page).not.toHaveURL(/없는|search=/);
    await expect(reset).toHaveCount(1);
    await reset.click();
    await expect(find).toHaveValue("");
    await expect(foot).toContainText(t("roster.foot.range", { shown: 200, total: fixture.count }));
    await fits(page, `directory filters ${width} ${theme}`);
    await expectAxe(page, `directory filters ${width} ${theme}`);
    expect(fixture.unexpected).toEqual([]);
  });

  test(`directory keeps rows during a sort read ${width} ${theme} @ui-state`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(value => localStorage.setItem("console.theme", value), theme);
    const fixture = await directory(page, true);
    await page.goto("/people");
    const grid = page.getByRole("grid", { name: t("people.table"), exact: true });
    const foot = page.getByRole("note", { name: t("roster.foot.label") });
    await expect(foot).toContainText(t("roster.foot.range", { shown: 100, total: fixture.count }));
    const rows = grid.getByRole("rowheader").filter({ hasText: /UI-\d+/ });
    const before = await rows.allTextContents();
    expect(before.length).toBeGreaterThan(0);
    if (width === 390) await page.getByRole("combobox", { name: t("uiLongTable.sort"), exact: true }).selectOption("number");
    else await grid.getByRole("columnheader", { name: t("people.col.number"), exact: true }).click();
    await expect.poll(() => fixture.requests.some(query => query.get("sort") === "employee_number")).toBe(true);
    await expect(rows).toHaveText(before);
    await expect(grid.getByText(t("uiLongTable.loading"), { exact: true })).toHaveCount(0);
    await expect(grid.getByText(t("uiLongTable.loadingMore"), { exact: true })).toHaveCount(0);
    await grid.evaluate(el => { el.scrollTop = el.scrollHeight; });
    expect(fixture.requests.filter(query => query.get("sort") === "employee_number" && query.has("cursor"))).toHaveLength(0);
    await grid.evaluate(el => { el.scrollTop = 0; });
    const sorted = page.waitForResponse(response => new URL(response.url()).searchParams.get("sort") === "employee_number");
    fixture.release();
    expect((await sorted).ok()).toBe(true);
    await expect(foot).toContainText(t("roster.foot.range", { shown: 100, total: fixture.count }));
    await expect(page).toHaveURL(/sort=employee_number/);
    await fits(page, `directory sorting ${width} ${theme}`);
    await expectAxe(page, `directory sorting ${width} ${theme}`);
    expect(fixture.unexpected).toEqual([]);
  });
}
