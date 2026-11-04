// SPDX-License-Identifier: LicenseRef-Proprietary
import { loadCatalog, t } from "@console/i18n";
import { expect, test } from "@playwright/test";
import { expectAxe, fits } from "../a11y";
import { employees, facets, failure, id, screenAccess, user } from "../mock/fixtures";
import { moveDetail } from "../mock/lifecycle-sheets";
import { mockRoute } from "../mock/route";
import { mockScreen } from "../mock/screen";
import { screens } from "./registry";
import { contractWindowSettings } from "../mock/directory";
import { addDays } from "../../apps/web/src/features/people/domain/roster";
import { todayKst } from "../../apps/web/src/lib/pure/today";

test.beforeAll(() => loadCatalog("ko"));

for (const width of [1440, 390]) for (const theme of ["light", "dark"]) {
  test(`unserved saved views stay hidden and outages can recover ${width} ${theme} @ui-state`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(value => localStorage.setItem("console.theme", value), theme);
    const fixture = await mockScreen(page, screens[1], "populated");
    const response = page.waitForResponse("**/api/v1/me/employee-views");
    await page.goto("/people");
    expect((await response).status()).toBe(404);
    const open = page.getByRole("button", { name: t("directoryViews.open"), exact: true });
    await expect(page.getByRole("grid", { name: t("people.table"), exact: true })).toBeVisible();
    await expect(open).toHaveCount(0);
    await expect(page.getByRole("status").filter({ hasText: t("common.read.failedReason") })).toHaveCount(0);
    expect(fixture.unexpected).toEqual([]);
    await fits(page, `unserved views ${width} ${theme}`);
    await expectAxe(page, `unserved views ${width} ${theme}`);
    await page.route("**/api/v1/me/employee-views", route => route.fulfill({ status: 503, json: failure("service_unavailable") }));
    await page.reload();
    await expect(page.getByRole("status").filter({ hasText: t("common.read.failedReason") })).toHaveCount(1, { timeout: 10_000 });
    await expect(open).toHaveCount(0);
    await fits(page, `saved views outage ${width} ${theme}`);
    await expectAxe(page, `saved views outage ${width} ${theme}`);
    await page.route("**/api/v1/me/employee-views", route => route.fulfill({ json: { items: [] } }));
    await page.getByRole("button", { name: t("common.retry"), exact: true }).click();
    await expect(open).toHaveCount(1);
    await expect(open).toBeVisible();
    expect(fixture.unexpected).toEqual([]);
  });

  for (const placement of ["", "unplaced"]) test(`settings outage keeps the ${placement || "employee"} roster ${width} ${theme} @ui-state`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(value => localStorage.setItem("console.theme", value), theme);
    const fixture = await mockScreen(page, screens[1], "populated");
    await mockRoute(page, "get", "/api/v1/settings", { status: 503, json: failure("service_unavailable") });
    if (placement) await mockRoute(page, "get", "/api/v1/access/me", { status: 200, json: {
      ...screenAccess("/people"), entries: [...screenAccess("/people").entries, ...screenAccess("/people/unplaced").entries],
    } });
    await mockRoute(page, "get", "/api/v1/employees/facets", request => {
      const result = facets(3);
      return { status: 200, json: { ...result, review: { ...result.review,
        contract_ending_before: new URL(request.url()).searchParams.has("contract_ending_before") ? 0 : null,
      } } };
    });
    await mockRoute(page, "get", "/api/v1/employees/import/unplaced", { status: 200, json: { count: 1, items: [{
      employee_id: id(100), name: "검증직원 1", company: "화면 검증 회사", reason: "no_place", employee_number: "UI-0001", employment_type: "REGULAR", hire_date: "2026-01-01",
    }] } });
    const requests: URLSearchParams[] = [];
    await mockRoute(page, "get", "/api/v1/employees", request => {
      requests.push(new URL(request.url()).searchParams);
      return { status: 200, json: { items: employees(3), total: 3, offset: 0, limit: 100, next_cursor: null } };
    });
    await page.goto(`/people?review=contractSoon,identity${placement ? `&placement=${placement}` : ""}`);
    await expect(page.getByRole("status").filter({ hasText: t("common.read.failedReason") })).toHaveCount(1, { timeout: 10_000 });
    const grid = page.getByRole("grid", { name: t("people.table"), exact: true });
    await expect(grid).toBeVisible();
    await expect(grid.getByText("UI-0001", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: t("directoryViews.contractSoon", { days: "—" }), exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: new RegExp(t("roster.review.contractSoon", { days: "—" })) })).toHaveCount(0);
    if (!placement) {
      await expect(page.getByRole("button", { name: new RegExp(`^${t("roster.status.ACTIVE")} 3$`) })).toBeVisible();
      expect(requests.length).toBeGreaterThan(0);
      expect(requests.every(query => !query.has("contract_ending_before") && query.get("identity_review_required") === "true")).toBe(true);
    }
    await fits(page, `settings outage ${placement} ${width} ${theme}`);
    await expectAxe(page, `settings outage ${placement} ${width} ${theme}`);
    await test.info().attach("settings-outage", { body: await page.screenshot({ path: test.info().outputPath("settings-outage.png"), fullPage: true }), contentType: "image/png" });
    await mockRoute(page, "get", "/api/v1/settings", { status: 200, json: contractWindowSettings(21) });
    await page.getByRole("button", { name: t("common.retry"), exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: t("common.read.failedReason") })).toHaveCount(0);
    await expect(page.getByRole("button", { name: t("directoryViews.contractSoon", { days: 21 }), exact: true })).toBeVisible();
    await expect(grid.getByText("UI-0001", { exact: true })).toBeVisible();
    if (placement) expect(requests).toHaveLength(0);
    expect(fixture.unexpected).toEqual([]);
  });

  test(`accounts continues by cursor and resets server filters ${width} ${theme} @ui-state`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(value => localStorage.setItem("console.theme", value), theme);
    const fixture = await mockScreen(page, screens[1], "large");
    const requests: URLSearchParams[] = [];
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    await page.route("**/api/v1/directory/people?*", async route => {
      const query = new URL(route.request().url()).searchParams;
      requests.push(query);
      if (query.has("search")) await held;
      const cursor = query.get("cursor");
      const offset = cursor ? Number(cursor.replace("account-", "")) : 0;
      const limit = Number(query.get("limit")), total = query.has("search") ? 0 : fixture.count;
      const end = Math.min(offset + limit, total);
      const items = Array.from({ length: Math.max(0, end - offset) }, (_, n) => ({ ...user, id: id(5000 + offset + n), display_name: `검색계정 ${offset + n + 1}` }));
      await route.fulfill({ json: { items, total, offset, limit, next_cursor: end < total ? `account-${end}` : null } });
    });
    await page.goto("/people?view=accounts");
    const grid = page.getByRole("grid", { name: t("accounts.table"), exact: true, includeHidden: true });
    await expect(grid).toBeVisible();
    await expect(grid).toHaveAttribute("data-layout", width === 390 ? "cards" : "rows");
    await grid.evaluate(el => { el.scrollTop = el.scrollHeight; });
    await expect.poll(() => requests.some(query => query.get("cursor") === "account-100")).toBe(true);
    expect(requests.every(query => !query.has("offset"))).toBe(true);
    expect(await grid.getByRole("row").count()).toBeLessThan(60);
    await fits(page, `accounts ${width} ${theme}`);
    await expectAxe(page, `accounts ${width} ${theme}`);
    await test.info().attach("accounts", { body: await page.screenshot({ path: test.info().outputPath("accounts.png"), fullPage: true }), contentType: "image/png" });
    const search = page.getByRole("combobox", { name: t("accounts.search.label"), exact: true });
    await search.fill("없는 계정");
    await expect.poll(() => requests.some(query => query.get("search") === "없는 계정")).toBe(true);
    await grid.evaluate(el => { el.scrollTop = el.scrollHeight; });
    await expect(grid.getByText(t("uiLongTable.loadingMore"), { exact: true })).toHaveCount(0);
    expect(requests.filter(query => query.has("search")).every(query => !query.has("cursor"))).toBe(true);
    release();
    await search.press("Tab");
    await expect(search).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByRole("heading", { name: t("accounts.noMatch.title"), exact: true })).toBeVisible();
    const filtered = requests.findLast(query => query.has("search"))!;
    expect(filtered.get("search")).toBe("없는 계정");
    expect(filtered.has("cursor")).toBe(false);
    expect(filtered.has("offset")).toBe(false);
    await page.getByRole("button", { name: t("accounts.includeInactive"), exact: true }).click();
    await expect.poll(() => requests.at(-1)?.get("include_inactive")).toBe("true");
    expect(requests.at(-1)!.has("cursor")).toBe(false);
    await fits(page, `accounts empty ${width} ${theme}`);
    await expectAxe(page, `accounts empty ${width} ${theme}`);
    expect(fixture.unexpected).toEqual([]);
  });

  test(`directory uses the effective contract window and shows the company ${width} ${theme} @ui-state`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(value => localStorage.setItem("console.theme", value), theme);
    const fixture = await mockScreen(page, screens[1], "large");
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    await mockRoute(page, "get", "/api/v1/settings", async () => {
      await held;
      return { status: 200, json: contractWindowSettings(21) };
    });
    const requests: URLSearchParams[] = [];
    await mockRoute(page, "get", "/api/v1/employees", request => {
      const query = new URL(request.url()).searchParams;
      requests.push(query);
      return { status: 200, json: { items: employees(100), total: fixture.count, offset: 0, limit: 100, next_cursor: null } };
    });
    await page.goto("/people?review=contractSoon,identity");
    await expect(page.getByRole("heading", { name: t("roster.page.roster"), exact: true })).toBeVisible();
    const views = page.getByRole("group", { name: t("roster.view.label"), exact: true });
    await expect(views.getByRole("button", { name: t("directoryViews.contractSoon", { days: "—" }), exact: true })).toHaveCount(0);
    expect(requests).toHaveLength(0);
    release();
    const grid = page.getByRole("grid", { name: t("people.table"), exact: true });
    await expect(grid).toBeVisible();
    const chip = page.getByRole("group", { name: t("people.filter.label"), exact: true }).getByRole("button", { name: new RegExp(t("roster.review.contractSoon", { days: 21 })) });
    await expect(chip).toHaveAttribute("aria-pressed", "true");
    await expect(views.getByRole("button", { name: t("directoryViews.contractSoon", { days: 21 }), exact: true })).toBeVisible();
    expect(requests.at(-1)!.get("contract_ending_before")).toBe(addDays(todayKst(), 22));
    if (width === 1440) {
      const company = grid.getByRole("gridcell").filter({ hasText: "화면 검증 회사" }).first();
      await expect(company).toBeVisible();
      expect(await company.evaluate(cell => cell.scrollWidth <= cell.clientWidth)).toBe(true);
    }
    await fits(page, `configured directory ${width} ${theme}`);
    await expectAxe(page, `configured directory ${width} ${theme}`);
    await test.info().attach("configured-directory", { body: await page.screenshot({ path: test.info().outputPath("configured-directory.png"), fullPage: true }), contentType: "image/png" });
    expect(fixture.unexpected).toEqual([]);
  });

  test(`personal directory views survive reload and replace server filters ${width} ${theme} @ui-state`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(value => localStorage.setItem("console.theme", value), theme);
    const fixture = await mockScreen(page, screens[1], "large");
    const saved: { id: string; name: string; filters: Record<string, string> }[] = [];
    const writes: unknown[] = [], requests: URLSearchParams[] = [], requestKeys: string[] = [];
    await page.route("**/api/v1/me/employee-views", async route => {
      if (route.request().method() === "POST") {
        const body = route.request().postDataJSON();
        writes.push(body);
        requestKeys.push(route.request().headers()["idempotency-key"]!);
        saved.push(body);
        return route.fulfill({ json: body });
      }
      return route.fulfill({ json: { items: saved } });
    });
    await mockRoute(page, "get", "/api/v1/employees", request => {
      const query = new URL(request.url()).searchParams;
      requests.push(query);
      const rows = query.has("search") ? [] : employees(fixture.count);
      const cursor = query.get("cursor");
      const offset = cursor ? rows.findIndex(row => row.id === cursor) + 1 : 0;
      const limit = Number(query.get("limit")), end = offset + limit;
      return { status: 200, json: { items: rows.slice(offset, end), total: rows.length, offset, limit,
        next_cursor: end < rows.length ? rows[end - 1]!.id : null } };
    });
    await mockRoute(page, "get", "/api/v1/employees/{id}", { status: 200, json: { ...moveDetail, employee: employees(1)[0]!, allowed_events: [] } });
    await mockRoute(page, "get", "/api/v1/employees/facets", request => ({ status: 200, json: facets(new URL(request.url()).searchParams.has("search") ? 0 : fixture.count) }));
    await mockRoute(page, "get", "/api/v1/employees/{id}/lifecycle-events", { status: 200, json: { items: [], head_version: 1, next_cursor: null } });
    await mockRoute(page, "get", "/api/v1/employees/{id}/end-options", { status: 403, json: failure("forbidden") });
    await page.goto("/people?status=ON_LEAVE&review=identity&sort=-hire_date");
    const find = page.getByRole("searchbox", { name: t("roster.find") });
    await find.fill("저장하지 않을 이름");
    await find.press("Enter");
    await expect(page.getByText(t("roster.empty.q", { q: "저장하지 않을 이름" }), { exact: true })).toBeVisible();
    const open = async () => {
      const button = page.getByRole("button", { name: t("directoryViews.open"), exact: true });
      await expect(button).toBeVisible();
      await button.click();
    };
    await open();
    const sheet = page.getByRole("dialog", { name: t("directoryViews.open"), exact: true });
    await expect(sheet.getByText(t("directoryViews.empty"), { exact: true })).toBeVisible();
    const save = sheet.getByRole("button", { name: t("composer.commit", { action: t("directoryViews.noun"), verb: t("composer.verb.save") }), exact: true });
    await sheet.getByRole("textbox", { name: new RegExp(t("directoryViews.name")) }).fill("   ");
    await save.click();
    await expect(sheet.getByText(t("directoryViews.required"), { exact: true })).toBeVisible();
    expect(writes).toHaveLength(0);
    await sheet.getByRole("textbox", { name: new RegExp(t("directoryViews.name")) }).fill("휴직 확인");
    await save.click();
    await expect(sheet.getByRole("button", { name: "휴직 확인", exact: true })).toBeVisible();
    expect(writes).toEqual([{ id: expect.any(String), name: "휴직 확인", filters: { status: "ON_LEAVE", review: "identity", sort: "-hire_date" } }]);
    expect(requestKeys).toEqual([saved[0]!.id]);
    await fits(page, `saved views ${width} ${theme}`);
    await expectAxe(page, `saved views ${width} ${theme}`);
    await test.info().attach("saved-view", { body: await page.screenshot({ path: test.info().outputPath("saved-view.png"), fullPage: true }), contentType: "image/png" });
    await page.goto("/people?status=EXITED&review=department&unit=obsolete&sort=employee_number");
    await open();
    await sheet.getByRole("button", { name: "휴직 확인", exact: true }).click();
    await expect(sheet).toBeHidden();
    await expect(page).toHaveURL(/status=ON_LEAVE/);
    await expect(page).toHaveURL(/review=identity/);
    await expect(page).toHaveURL(/sort=-hire_date/);
    await expect(page).not.toHaveURL(/unit=|sel=|search=/);
    await expect(find).toHaveValue("");
    const grid = page.getByRole("grid", { name: t("people.table"), exact: true });
    const foot = page.getByRole("note", { name: t("roster.foot.label") });
    await expect(foot).toContainText(t("roster.foot.range", { shown: 100, total: fixture.count }));
    await grid.evaluate(el => { el.scrollTop = el.scrollHeight; });
    await expect(foot).toContainText(t("roster.foot.range", { shown: 200, total: fixture.count }));
    const next = requests.findLast(query => query.has("cursor"))!;
    expect(next.get("sort")).toBe("-hire_date");
    expect(next.getAll("status")).toEqual(["ON_LEAVE"]);
    expect(next.get("identity_review_required")).toBe("true");
    expect(next.has("offset")).toBe(false);
    expect(await grid.getByRole("row").count()).toBeLessThan(60);
    await fits(page, `restored view ${width} ${theme}`);
    // Check the restored controls here; large-roster row accessibility has its own directory state specs.
    await expectAxe(page, `restored view ${width} ${theme}`, { include: '[role="group"], [role="columnheader"], [role="note"]' });
    await grid.evaluate(el => { el.scrollTop = 0; });
    await grid.getByText("UI-0001", { exact: true }).click();
    const peek = page.getByRole("complementary", { name: t("people.panel"), exact: true });
    await expect(peek.getByRole("heading", { level: 2 })).toContainText("검증직원 1");
    await expect(peek.getByRole("link", { name: new RegExp(t("people.panel.open")) })).toHaveAttribute("href", `/people/${id(100)}`);
    await fits(page, `directory peek ${width} ${theme}`);
    await expectAxe(page, `directory peek ${width} ${theme}`, { include: `aside[aria-label="${t("people.panel")}"]` });
    await test.info().attach("peek", { body: await page.screenshot({ path: test.info().outputPath("peek.png"), fullPage: true }), contentType: "image/png" });
    await peek.getByRole("button", { name: t("roster.panel.close"), exact: true }).click();
    await expect(peek).toBeHidden();
    await page.goto("/_gallery?entry=roster-saved-views");
    await open();
    await expect(sheet.getByRole("button", { name: "휴직 확인", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.scrollingElement!.scrollWidth <= innerWidth)).toBe(true);
    await expectAxe(page, `view gallery ${width} ${theme}`, { include: '[role="dialog"]' });
    await mockRoute(page, "get", "/api/v1/employees", { status: 200, json: { items: [], total: 0, offset: 0, limit: 100, next_cursor: null } });
    await mockRoute(page, "get", "/api/v1/employees/facets", { status: 200, json: facets(0) });
    await page.goto("/people");
    await expect(page.getByRole("heading", { name: t("roster.first.title"), exact: true })).toBeVisible();
    await fits(page, `empty directory ${width} ${theme}`);
    await expectAxe(page, `empty directory ${width} ${theme}`);
    await mockRoute(page, "get", "/api/v1/employees", { status: 403, json: failure("forbidden") });
    await page.reload();
    await expect(page.getByRole("heading", { name: t("common.denied.title.plain"), exact: true })).toBeVisible();
    await fits(page, `directory access ${width} ${theme}`);
    await expectAxe(page, `directory access ${width} ${theme}`);
    expect(fixture.unexpected).toEqual([]);
  });
}

for (const width of [1440, 390]) {
  test(`account picker states remain accessible at ${width}px in both themes @ui-state`, async ({ page }, testInfo) => {
    testInfo.setTimeout(90_000);
    await page.setViewportSize({ width, height: 900 });
    const fixture = await mockScreen(page, screens[1], "populated");
    let release: (() => void) | undefined;
    await page.route("**/api/v1/directory/people?*", async route => {
      const search = new URL(route.request().url()).searchParams.get("search") ?? "";
      if (search === "보류") await new Promise<void>(resolve => { release = resolve; });
      if (search === "실패") return route.fulfill({ status: 503, json: failure("service_unavailable") });
      const count = search === "없음" ? 0 : search === "넓음" || !search ? 60 : 3;
      const items = Array.from({ length: Math.min(count, 3) }, (_, n) => ({ ...user, id: id(7000 + n), display_name: `검색계정 ${n + 1}` }));
      return route.fulfill({ json: { items, total: count, offset: 0, limit: 100, next_cursor: null } });
    });
    try {
      await page.goto("/people?view=accounts");
      const search = page.getByRole("combobox", { name: t("accounts.search.label"), exact: true });
      await search.fill("넓음");
      await expect(page.getByText(t("uiServerPicker.narrow", { count: 3 }), { exact: true })).toBeVisible();
      await expectAxe(page, `account-search/truncated/${width}`);

      await search.fill("건수");
      await expect(page.getByText(t("uiServerPicker.count", { count: 3 }), { exact: true })).toBeVisible();
      await expectAxe(page, `account-search/count/${width}`);

      await search.dispatchEvent("compositionstart");
      await search.fill("조합");
      await expect(page.getByText(t("uiServerPicker.loading"), { exact: true }).first()).toBeVisible();
      await expectAxe(page, `account-search/composing/${width}`);
      await search.dispatchEvent("compositionend");

      await search.fill("보류");
      await expect.poll(() => release).toBeTruthy();
      await expect(page.getByText(t("uiServerPicker.loading"), { exact: true }).first()).toBeVisible();
      await expectAxe(page, `account-search/loading/${width}`);
      release?.();
      await expect(page.getByText(t("uiServerPicker.count", { count: 3 }), { exact: true })).toBeVisible();

      await search.fill("없음");
      await expect(page.getByText(t("uiServerPicker.none"), { exact: true })).toBeVisible();
      await expectAxe(page, `account-search/empty/${width}`);

      const failed = page.waitForResponse(response => new URL(response.url()).searchParams.get("search") === "실패");
      await search.fill("실패");
      await failed;
      await expect(search).toHaveAttribute("aria-invalid", "true", { timeout: 20_000 });
      await expectAxe(page, `account-search/failed/${width}`);
      await fits(page, `account-search/${width}`);
      expect(fixture.unexpected).toEqual([]);
    } finally {
      release?.();
      await page.close();
      fixture.release();
    }
  });
}
