// SPDX-License-Identifier: LicenseRef-Proprietary
import { loadCatalog, t } from "@console/i18n";
import { expect, test, type Page } from "@playwright/test";
import { expectAxe, fits } from "../a11y";
import { employees, facets } from "../mock/fixtures";
import { mockRoute } from "../mock/route";
import { mockScreen } from "../mock/screen";
import { screens } from "./registry";

test.beforeAll(() => loadCatalog("ko"));

async function directory(page: Page) {
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
    if (reviewed) await held;
    const cursor = query.get("cursor");
    const offset = cursor ? matching.findIndex(row => row.id === cursor) + 1 : 0;
    const limit = Number(query.get("limit")), end = offset + limit;
    return { status: 200, json: { items: matching.slice(offset, end), total: matching.length, offset, limit,
      next_cursor: end < matching.length ? matching[end - 1]!.id : null } };
  });
  await mockRoute(page, "get", "/api/v1/employees/facets", request => {
    const query = new URL(request.url()).searchParams;
    const result = facets(query.has("search") ? 0 : query.has("register_review_required") ? 250 : fixture.count);
    return { status: 200, json: { ...result, review: { ...result.review, register_review_required: 250, contract_ending_before: 250 } } };
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
    await expect(foot).toContainText(t("roster.foot.range", { shown: 100, total: fixture.count }));
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
    fixture.release();
    await expect(foot).toContainText(t("roster.foot.range", { shown: 100, total: 250 }));
    const active = filters.getByRole("button", { name: new RegExp(t("roster.review.contractSoon", { days: 60 })) });
    await expect(active).toHaveAttribute("aria-pressed", "true");
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
    await expect(page).not.toHaveURL(/review=/);
    await expect(foot).toContainText(t("roster.foot.range", { shown: 200, total: fixture.count }));

    await page.getByRole("button", { name: t("roster.view.gaps"), exact: true }).click();
    await expect(foot).toContainText(t("roster.foot.range", { shown: 100, total: 250 }));
    await expect(filters.getByRole("button", { name: new RegExp(t("roster.review.register")) })).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: t("people.filter.reset"), exact: true }).click();
    await expect(page).not.toHaveURL(/review=/);
    await expect(page.getByRole("heading", { level: 1 })).toBeFocused();

    const find = page.getByRole("searchbox", { name: t("roster.find") });
    await find.fill("없는 직원");
    await find.press("Enter");
    await expect(page.getByText(t("roster.empty.q", { q: "없는 직원" }), { exact: true })).toBeVisible();
    await expect(page).not.toHaveURL(/없는|search=/);
    await page.getByRole("button", { name: t("people.filter.reset"), exact: true }).first().click();
    await expect(find).toHaveValue("");
    await expect(foot).toContainText(t("roster.foot.range", { shown: 200, total: fixture.count }));
    await fits(page, `directory filters ${width} ${theme}`);
    await expectAxe(page, `directory filters ${width} ${theme}`);
    expect(fixture.unexpected).toEqual([]);
  });
}
