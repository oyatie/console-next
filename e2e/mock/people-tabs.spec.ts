// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test, type Page } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { expectAxe, fits } from "../a11y";
import { authz, failure, id, screenAccess } from "./fixtures";
import { mockRoute } from "./route";
import { mockScreen } from "./screen";
import { screens } from "../states/registry";

test.beforeAll(() => loadCatalog("ko"));

async function fixture(page: Page) {
  const state = await mockScreen(page, screens[1], "populated");
  await page.addInitScript(() => {
    const fetch = window.fetch;
    window.fetch = (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (new URL(request.url).pathname !== "/api/v1/events") return fetch(input, init);
      return Promise.resolve(new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode(": connected\n\n"));
        window.addEventListener("test-refresh", () => controller.enqueue(new TextEncoder().encode('event: change\ndata: {"type":"tenant","id":null}\n\n')));
        request.signal.addEventListener("abort", () => controller.close(), { once: true });
      } }), { headers: { "content-type": "text/event-stream" } }));
    };
  });
  const entries = ["/people", "/people/bulk", "/people/notices", "/people/exits", "/people/unplaced"].flatMap(path => screenAccess(path).entries);
  await mockRoute(page, "get", "/api/v1/me/authz", { status: 200, json: { ...authz, capabilities: [...authz.capabilities, { feature: "employee_directory_manage", permission: "allow", branch_scope: { kind: "all" }, org_wide: true, scoped: false }] } });
  await mockRoute(page, "get", "/api/v1/access/me", { status: 200, json: { ...screenAccess("/people"), entries } });
  await mockRoute(page, "get", "/api/v1/job-titles", { status: 200, json: { items: [], can_manage: true } });
  await mockRoute(page, "get", "/api/v1/reason-codes", request => ({ status: 200, json: { domain: new URL(request.url()).searchParams.get("domain")!, items: [] } }));
  await mockRoute(page, "get", "/api/v1/appointment-notices", { status: 200, json: { items: [], next_cursor: null } });
  await mockRoute(page, "get", "/api/v1/hr/exit-cases", { status: 200, json: { items: [], total: 0, limit: 100, offset: 0 } });
  await mockRoute(page, "get", "/api/v1/employees/import/unplaced", { status: 200, json: { count: 1, next_cursor: null, items: [{ employee_id: id(10), name: "가상미배치", employee_number: "U-001", company: "화면 검증 회사", reason: "no_place" }] } });
  return state;
}

for (const width of [1440, 390]) for (const theme of ["light", "dark"]) {
  test(`people page hosts three URL tabs at ${width}px in ${theme}`, async ({ page }, info) => {
    const state = await fixture(page);
    await page.setViewportSize({ width, height: 1000 });
    await page.addInitScript(value => localStorage.setItem("console.theme", value), theme);
    try {
      await page.goto("/people?sort=hire_date&review=identity#people-title");
      const main = page.getByRole("main");
      const nav = main.getByRole("navigation", { name: "직원", exact: true });
      const links = nav.getByRole("link");
      await expect(links).toHaveText(["명부", "발령", "퇴직 진행"]);
      const destination = new URL((await links.nth(1).getAttribute("href"))!, page.url());
      expect(destination.searchParams.get("tab")).toBe("appointments");
      expect(destination.searchParams.get("sort")).toBe("hire_date");
      expect(destination.searchParams.get("review")).toBe("identity");
      expect(destination.hash).toBe("#people-title");
      await expect(links.first()).toHaveAttribute("aria-current", "page");
      await expect(main.getByRole("heading", { level: 1, name: "직원", exact: true })).toBeVisible();
      const history = await page.evaluate(() => window.history.length);
      await links.first().focus();
      await page.keyboard.press("Tab");
      await expect(links.nth(1)).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(links.nth(1)).toHaveAttribute("aria-current", "page");
      await expect(main.getByText(t("bulk.page.empty.title"), { exact: true })).toBeVisible();
      await expect(main.getByRole("heading", { name: t("notice.title"), exact: true })).toBeVisible();
      await expect(page).toHaveURL(/tab=appointments/);
      expect(new URL(page.url()).searchParams.get("review")).toBe("identity");
      expect(await page.evaluate(() => window.history.length)).toBe(history);
      await fits(page, `appointments ${width} ${theme}`);
      await expectAxe(page, "appointments");
      await page.screenshot({ path: info.outputPath(`appointments-${width}-${theme}.png`), fullPage: true });
      await page.keyboard.press("Tab");
      await expect(links.nth(2)).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(links.nth(2)).toHaveAttribute("aria-current", "page");
      await expect(main.getByRole("grid", { name: t("exit.list.title"), exact: true })).toBeVisible();
      await main.getByRole("button", { name: new RegExp(t("exit.list.chip.closed")) }).click();
      await expect(page).toHaveURL(/exitStatus=closed/);
      await page.reload();
      await expect(links.nth(2)).toHaveAttribute("aria-current", "page");
      await expect(main.getByRole("button", { name: new RegExp(t("exit.list.chip.closed")) })).toHaveAttribute("aria-pressed", "true");
      await fits(page, `exits ${width} ${theme}`);
      await expectAxe(page, "exits");
      await page.screenshot({ path: info.outputPath(`exits-${width}-${theme}.png`), fullPage: true });
      await links.first().click();
      await expect(main.getByRole("grid", { name: "직원", exact: true })).toBeVisible();
      expect(new URL(page.url()).searchParams.get("sort")).toBe("hire_date");
      await expect(main.locator("h1")).toHaveCount(1);
      await expect(page.locator("main")).toHaveCount(1);
      await fits(page, `roster ${width} ${theme}`);
      await expectAxe(page, "roster");
      await page.screenshot({ path: info.outputPath(`roster-${width}-${theme}.png`), fullPage: true });
      expect(state.unexpected).toEqual([]);
    } finally { await page.close(); state.release(); }
  });
}

test("unplaced is a roster filter with the queue's rows on LongTable", async ({ page }) => {
  const state = await fixture(page);
  try {
    await page.goto("/people");
    await page.getByRole("button", { name: "미배치", exact: true }).click();
    await expect(page).toHaveURL(/placement=unplaced/);
    const grid = page.getByRole("grid", { name: "직원", exact: true });
    await expect(grid.getByText("가상미배치", { exact: true })).toBeVisible();
    await expect(grid.locator("[aria-sort]")).toHaveCount(0);
    await expect(page.getByRole("navigation", { name: "직원", exact: true }).getByRole("link").first()).toHaveAttribute("aria-current", "page");
    await page.reload();
    await expect(grid.getByText("가상미배치", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: t("roster.unplaced.place"), exact: true })).toHaveAttribute("href", "/people/unplaced");
    const roster = page.getByRole("navigation", { name: "직원", exact: true }).getByRole("link", { name: "명부", exact: true });
    expect(new URL((await roster.getAttribute("href"))!, page.url()).searchParams.has("placement")).toBe(false);
    await roster.click();
    await expect(page).not.toHaveURL(/placement=/);
    await expect(grid.getByText("가상미배치", { exact: true })).toHaveCount(0);
    await expect(grid).toBeVisible();
    expect(state.unexpected).toEqual([]);
  } finally { await page.close(); state.release(); }
});

for (const reader of ["viewer", "workplace editor"] as const) {
  test(`${reader} cannot select unplaced and a direct link keeps the permitted roster`, async ({ page }) => {
    const state = await fixture(page);
    const access = screenAccess("/people");
    if (reader === "workplace editor") access.entries.push(...screenAccess("/people/unplaced").entries.map(entry => ({ ...entry, scope: { ...entry.scope, kind: "WORKPLACE" as const, id: id(4) } })));
    await mockRoute(page, "get", "/api/v1/me/authz", { status: 200, json: authz });
    await mockRoute(page, "get", "/api/v1/access/me", { status: 200, json: access });
    const unplacedReads: string[] = [];
    page.on("request", request => { if (new URL(request.url()).pathname === "/api/v1/employees/import/unplaced") unplacedReads.push(request.url()); });
    try {
      await page.goto("/people");
      const grid = page.getByRole("grid", { name: "직원", exact: true });
      await expect(grid).toBeVisible();
      await expect(page.getByRole("button", { name: "미배치", exact: true })).toHaveCount(0);
      await page.goto("/people?placement=unplaced&sort=hire_date#people-title");
      await expect(grid).toBeVisible();
      const notice = page.getByRole("note").filter({ hasText: t("roster.unplaced.unavailable") });
      await expect(notice).toBeVisible();
      await expect(page.getByRole("button", { name: "미배치", exact: true })).toHaveCount(0);
      await expect(page.getByText("가상미배치", { exact: true })).toHaveCount(0);
      const roster = page.getByRole("navigation", { name: "직원", exact: true }).getByRole("link", { name: "명부", exact: true });
      const destination = new URL((await roster.getAttribute("href"))!, page.url());
      expect(destination.searchParams.has("placement")).toBe(false);
      expect(destination.searchParams.get("sort")).toBe("hire_date");
      expect(destination.hash).toBe("#people-title");
      await roster.click();
      await expect(page).not.toHaveURL(/placement=/);
      await expect(grid).toBeVisible();
      await expect(notice).toHaveCount(0);
      expect(unplacedReads).toEqual([]);
      expect(state.unexpected).toEqual([]);
    } finally { await page.close(); state.release(); }
  });
}

test("an unplaced API refusal keeps the roster controls available", async ({ page }) => {
  const state = await fixture(page);
  await mockRoute(page, "get", "/api/v1/employees/import/unplaced", { status: 403, json: failure("access_denied") });
  try {
    await page.goto("/people?placement=unplaced");
    await expect(page.getByText(t("common.denied.title.plain"), { exact: true })).toBeVisible();
    await page.getByRole("button", { name: t("roster.view.current"), exact: true }).click();
    await expect(page).not.toHaveURL(/placement=/);
    await expect(page.getByRole("grid", { name: "직원", exact: true })).toBeVisible();
    expect(state.unexpected).toEqual([]);
  } finally { await page.close(); state.release(); }
});

for (const tab of ["appointments", "exits"] as const) {
  test(`${tab} enforces its own served access requirement before loading content`, async ({ page }) => {
    const state = await fixture(page);
    const access = screenAccess("/people");
    if (tab === "exits") access.entries = access.entries.map(entry => ({ ...entry, scope: { ...entry.scope, kind: "DEPARTMENT", id: id(4) } }));
    await mockRoute(page, "get", "/api/v1/access/me", { status: 200, json: access });
    const exitReads: string[] = [];
    page.on("request", request => { if (new URL(request.url()).pathname === "/api/v1/hr/exit-cases") exitReads.push(request.url()); });
    try {
      await page.goto(`/people?tab=${tab}&bulk=paste`);
      const main = page.getByRole("main");
      await expect(main.getByText(t("common.denied.title.plain"), { exact: true })).toBeVisible();
      if (tab === "appointments") {
        await expect(main.getByText(t("notice.list.empty"), { exact: true })).toBeVisible();
        await expect(main.getByRole("button", { name: t("bulk.openPaste"), exact: true })).toHaveCount(0);
        await expect(page.getByRole("dialog")).toHaveCount(0);
      } else {
        await expect(main.getByRole("grid", { name: t("exit.list.title"), exact: true })).toHaveCount(0);
        expect(exitReads).toEqual([]);
      }
      await main.getByRole("navigation", { name: "직원", exact: true }).getByRole("link", { name: "명부", exact: true }).click();
      await expect(main.getByRole("grid", { name: "직원", exact: true })).toBeVisible();
      expect(state.unexpected).toEqual([]);
    } finally { await page.close(); state.release(); }
  });
}

for (const textSize of ["100%", "75%"]) {
  test(`people tabs move overflow into 더 보기 and keep the selected view visible at ${textSize} text`, async ({ page }) => {
    const state = await fixture(page);
    try {
      await page.goto("/people?sort=hire_date&review=identity#people-title");
      const main = page.getByRole("main");
      const nav = main.getByRole("navigation", { name: "직원", exact: true });
      await expect(nav.getByRole("link")).toHaveText(["명부", "발령", "퇴직 진행"]);
      await nav.evaluate((el, size) => { el.style.fontSize = size; }, textSize);
      await page.evaluate(() => document.fonts.ready);
      const history = await page.evaluate(() => window.history.length);
      // Exclude the gaps so overflow does not depend on platform font metrics.
      const width = await nav.getByRole("link").evaluateAll(links => links.reduce((total, link) => total + link.getBoundingClientRect().width, 0));
      await nav.evaluate((el, width) => { el.style.maxInlineSize = `${width}px`; }, width);
      await nav.getByRole("button", { name: "더 보기", exact: true }).click();
      const more = page.getByRole("dialog", { name: "더 보기", exact: true });
      await more.getByRole("link", { name: "퇴직 진행", exact: true }).press("Enter");
      await expect(more).toBeHidden();
      await expect(nav.locator('[aria-current="page"]')).toHaveText("퇴직 진행");
      await expect(main.locator('[data-page-view="exits"]')).toBeVisible();
      await expect(main.getByRole("grid", { name: t("exit.list.title"), exact: true })).toBeVisible();
      expect(await nav.evaluate(el => el.scrollWidth - el.clientWidth)).toBe(0);
      expect(await page.evaluate(() => window.history.length)).toBe(history);
      const url = new URL(page.url());
      expect(url.searchParams.get("sort")).toBe("hire_date");
      expect(url.searchParams.get("review")).toBe("identity");
      expect(url.hash).toBe("#people-title");
      expect(state.unexpected).toEqual([]);
    } finally { await page.close(); state.release(); }
  });
}

for (const [tab, path] of [["roster", "/api/v1/employees"], ["appointments", "/api/v1/appointment-notices"], ["exits", "/api/v1/hr/exit-cases"]] as const) {
  test(`${tab} keeps page navigation through refused and stale reads`, async ({ page }) => {
    const state = await fixture(page);
    let mode: "ready" | "stale" | "refused" = "ready";
    await page.route(url => url.pathname === path, async route => {
      if (mode === "ready") return route.fallback();
      await route.fulfill({ status: mode === "refused" ? 403 : 503, json: failure(mode === "refused" ? "forbidden" : "service_unavailable") });
    });
    try {
      await page.goto(`/people?tab=${tab}`);
      const main = page.getByRole("main");
      const target = tab === "appointments" ? main.getByText(t("notice.list.empty"), { exact: true }) : main.getByRole("grid").first();
      await expect(target).toBeVisible();
      mode = "stale";
      await page.evaluate(() => window.dispatchEvent(new Event("test-refresh")));
      await expect(main.getByRole("button", { name: t("common.retry"), exact: true }).first()).toBeVisible({ timeout: 20_000 });
      await expect(target).toBeVisible();
      mode = "refused";
      await main.getByRole("button", { name: t("common.retry"), exact: true }).first().click();
      await expect(main.getByText(t("common.denied.title.plain"), { exact: true })).toBeVisible();
      await expect(main.getByRole("navigation", { name: "직원", exact: true }).getByRole("link")).toHaveCount(3);
      await expect(target).toHaveCount(0);
      expect(state.unexpected).toEqual([]);
    } finally { await page.close(); state.release(); }
  });
}
