// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { loadCatalog, t } from "@console/i18n";
import { mockScreen } from "./screen";
import { mockRoute } from "./route";
import { checklist, failure, inbox, user } from "./fixtures";
import { expectAxe, fits } from "../a11y";
import { expectStable, recordShifts } from "../stability";
import { screens } from "../states/registry";

test.beforeAll(() => loadCatalog("ko"));

for (const width of [1440, 390]) for (const theme of ["light", "dark"]) {
  test(`Home keeps live server lane counts without attention filters at ${width}px ${theme}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(value => localStorage.setItem("console.theme", value), theme);
    const mock = await mockScreen(page, screens[0], "populated");
    const queue = inbox(8);
    queue.available_filters = ["turn", "scheduled", "waiting", "deadlines", "failures"];
    queue.counts = {
      turn: { total: 31, total_is_exact: false }, scheduled: { total: 0, total_is_exact: true },
      waiting: { total: 2, total_is_exact: true }, deadlines: { total: 1, total_is_exact: true }, failures: { total: 0, total_is_exact: true },
    };
    await mockRoute(page, "get", "/api/v1/me/action-inbox", request => ({ status: 200, json: {
      ...queue, items: new URL(request.url()).searchParams.get("filter") === "scheduled" ? [] : queue.items,
    } }));
    await page.goto("/");
    const preview = page.getByRole("region", { name: t("home.inbox.title"), exact: true });
    await expect(preview.locator("[data-id]")).toHaveCount(5);
    await expect(preview.getByRole("group", { name: t("home.attention.label"), exact: true })).toHaveCount(0);
    const lanes = preview.getByRole("navigation", { name: t("home.lanes"), exact: true });
    await expect(lanes.getByRole("link")).toHaveCount(queue.available_filters.length + 1);
    for (const key of queue.available_filters) {
      const count = queue.counts[key]!;
      const label = t(count.total_is_exact ? "home.inbox.filterCount" : "home.inbox.filterCount.lower", { filter: t(`home.inbox.filter.${key}`), count: count.total });
      await expect(lanes.getByRole("link", { name: label, exact: true })).toHaveAttribute("href", `/inbox?tab=${key}`);
    }
    await fits(page, `Home live lanes at ${width}px ${theme}`);
    await expectAxe(page, `Home live lanes at ${width}px ${theme}`);
    await page.screenshot({ path: info.outputPath(`home-live-${width}-${theme}.png`), fullPage: true });
    await lanes.getByRole("link", { name: /^예정/, exact: false }).click();
    await expect(page).toHaveURL(/\/inbox\?tab=scheduled$/);
    await expect(page.getByRole("heading", { name: t("home.inbox.empty.title"), exact: true })).toBeVisible();
    expect(mock.unexpected).toEqual([]);
  });

  test(`inbox shares Home rows and server URL filters at ${width}px ${theme}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(value => localStorage.setItem("console.theme", value), theme);
    const mock = await mockScreen(page, screens[0], "populated");
    const queue = inbox(8);
    queue.available_filters = ["turn", "scheduled", "waiting", "deadlines", "failures"];
    queue.counts = {
      turn: { total: 31, total_is_exact: false }, scheduled: { total: 0, total_is_exact: true },
      waiting: { total: 2, total_is_exact: true }, deadlines: { total: 1, total_is_exact: true }, failures: { total: 0, total_is_exact: true },
    };
    const attention = [
      { key: "all", total: 8, total_is_exact: true },
      { key: "approvals", total: 2, total_is_exact: true },
      { key: "today", total: 1, total_is_exact: true },
      { key: "overdue", total: 1, total_is_exact: false },
    ];
    const scheduled = t("home.inbox.filterCount", { filter: t("home.inbox.filter.scheduled"), count: 0 });
    await mockRoute(page, "get", "/api/v1/me/action-inbox", request => {
      const query = new URL(request.url()).searchParams;
      const offset = query.has("cursor") ? 8 : 0;
      const attentionKey = query.get("attention");
      const items = query.get("filter") === "scheduled" ? [] : attentionKey === "approvals" ? queue.items.slice(0, 2) : attentionKey === "today" ? queue.items.slice(2, 3) : attentionKey === "overdue" ? queue.items.slice(3, 4) : queue.items;
      return { status: 200, json: { ...queue, attention_filters: attention, items: offset ? [{ ...queue.items[0]!, id: "second-page", title: "다음 페이지 직원", reason: "결재 차례입니다", age_days: 12 }] : items.map(item => ({ ...item, reason: "결재 차례입니다", age_days: 12 })), next_cursor: offset || !items.length ? null : "next" } };
    });
    await page.goto("/");
    const preview = page.getByRole("region", { name: t("home.inbox.title"), exact: true });
    await expect(preview.locator("[data-id]")).toHaveCount(5);
    const attentionFilters = preview.getByRole("group", { name: "확인 필요", exact: true });
    await expect(attentionFilters.getByRole("button")).toHaveCount(4);
    await expect(attentionFilters.getByRole("button", { name: /^전체\s*8$/ })).toHaveAttribute("aria-pressed", "true");
    await attentionFilters.getByRole("button", { name: /^결재\s*2$/ }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(preview.locator("[data-id]")).toHaveCount(2);
    for (const [label, index] of [[/^오늘\s*1$/, 2], [/^기한 지남\s*1\+$/, 3]] as const) {
      const chip = attentionFilters.getByRole("button", { name: label });
      await chip.click();
      await expect(chip).toHaveAttribute("aria-pressed", "true");
      await expect(preview.locator("[data-id]")).toHaveCount(1);
      await expect(preview.locator("[data-id]")).toHaveAttribute("data-id", queue.items[index]!.id);
      await expect(page).toHaveURL(/\/$/);
    }
    await attentionFilters.getByRole("button", { name: /^전체\s*8$/ }).click();
    await expect(preview.locator("[data-id]")).toHaveCount(5);
    await expect(preview.getByRole("columnheader", { name: t("home.inbox.column.due"), exact: true })).toHaveCount(1);
    await expect(preview.getByRole("columnheader", { name: t("home.inbox.column.owner"), exact: true })).toHaveCount(0);
    if (width === 390) await expect(preview.getByRole("link", { name: t("home.inbox.action.contract"), exact: true }).first()).toBeVisible();
    await expect(preview.getByRole("button", { name: t("home.inbox.more"), exact: true })).toHaveCount(0);
    await fits(page, `Home worklist at ${width}px`);
    await expectAxe(page, `Home worklist at ${width}px ${theme}`);
    await page.screenshot({ path: info.outputPath(`home-${width}-${theme}.png`), fullPage: true });
    if (width === 390) expect(new Set(await attentionFilters.getByRole("button").evaluateAll(buttons => buttons.map(button => Math.round(button.getBoundingClientRect().top)))).size).toBe(1);
    const viewAll = preview.getByRole("link", { name: t("home.inbox.viewInbox"), exact: true });
    await expect(viewAll).toHaveAttribute("href", "/inbox");
    await viewAll.click();
    await expect(page).toHaveURL(/\/inbox$/);
    await expect(page.getByRole("heading", { level: 1, name: t("home.inbox.title"), exact: true })).toBeVisible();
    await expect(page.locator("main header time[datetime]")).toBeVisible();
    await expect(preview.locator(":scope > div")).toHaveCount(1);
    const tabs = page.getByRole("navigation", { name: t("home.lanes"), exact: true });
    await expect(tabs.getByRole("link")).toHaveCount(queue.available_filters.length + 1);
    const myTurn = tabs.getByRole("link", { name: /^내 차례\s*31\+$/ });
    await expect(myTurn).toHaveAttribute("href", "/inbox?tab=turn");
    await expect(tabs.getByRole("link").nth(2)).toContainText("0");
    if (width === 390) expect(new Set(await tabs.getByRole("link").evaluateAll(links => links.map(link => Math.round(link.getBoundingClientRect().top)))).size).toBe(1);
    await expect(preview.locator("[data-id]")).toHaveCount(8);
    expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations).toEqual([]);
    await preview.getByRole("button", { name: t("home.inbox.more"), exact: true }).click();
    await expect(preview.locator('[data-id="second-page"]')).toContainText("다음 페이지 직원");
    await tabs.getByRole("link", { name: scheduled, exact: true }).click();
    await expect(page).toHaveURL(/\?tab=scheduled$/);
    await expect(tabs.getByRole("link", { name: scheduled, exact: true })).toHaveAttribute("aria-current", "page");
    await expect(tabs.getByRole("link").first()).toHaveText(t("home.inbox.filter.all"));
    await expect(preview.getByRole("heading", { name: t("home.inbox.empty.title"), exact: true })).toBeVisible();
    await page.reload();
    await expect(tabs.getByRole("link", { name: scheduled, exact: true })).toHaveAttribute("aria-current", "page");
    expect(await page.locator("main").evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations).toEqual([]);
    await page.screenshot({ path: info.outputPath(`inbox-${width}-${theme}.png`), fullPage: true });
    await page.goBack();
    await expect(page).toHaveURL(/\/$/);
    expect(mock.unexpected).toEqual([]);
  });
}

test("setup inbox sends the caller Home without duplicating checklist or account work", async ({ page }) => {
  const mock = await mockScreen(page, screens[0], "empty");
  await mockRoute(page, "get", "/api/v1/me/action-inbox", { status: 200, json: { ...inbox(1), setup: { ...checklist, phase: "SETUP" } } });
  await page.goto("/inbox");
  await expect(page.getByRole("heading", { level: 1, name: t("home.inbox.title"), exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: t("home.inbox.title"), exact: true }).locator("[data-id]")).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: t("home.lanes"), exact: true })).toHaveCount(0);
  const home = page.locator("main").getByRole("link", { name: t("shell.link.home"), exact: true });
  await expect(home).toHaveAttribute("href", "/");
  expect(mock.unexpected).toEqual([]);
});

test("inbox keeps its title on failed reads and retries without claiming empty", async ({ page }) => {
  await page.addInitScript(recordShifts);
  await mockScreen(page, screens[0], "failed");
  await page.goto("/inbox");
  await expect(page.getByRole("heading", { level: 1, name: t("home.inbox.title"), exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: t("common.loadFailed.title"), exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(t("home.inbox.empty.title"), { exact: true })).toHaveCount(0);
  await expect(page.getByRole("region", { name: t("home.inbox.title"), exact: true }).locator('[data-bone="short"]')).toHaveCount(0);
  await mockRoute(page, "get", "/api/v1/me/action-inbox", { status: 200, json: inbox(1) });
  await page.getByRole("button", { name: t("common.retry"), exact: true }).click();
  await expect(page.locator("[data-id]")).toHaveCount(1);
  await expectStable(page, "failed inbox recovery");
});

test("Home hides the inbox link when the server offers no work or personal filter", async ({ page }) => {
  await mockScreen(page, screens[0], "empty");
  await mockRoute(page, "get", "/api/v1/me/action-inbox", { status: 200, json: { ...inbox(0), available_filters: [] } });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: t("home.noWork.title"), exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: t("home.inbox.viewInbox"), exact: true })).toHaveCount(0);
});

for (const path of ["/", "/inbox"]) {
  test(`an empty queue on ${path} shows arriving items without a refresh`, async ({ page }) => {
    const mock = await mockScreen(page, screens[0], "empty");
    await page.addInitScript(() => {
      const fetch = window.fetch;
      window.fetch = (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        if (new URL(request.url).pathname !== "/api/v1/events") return fetch(input, init);
        return Promise.resolve(new Response(new ReadableStream({ start(controller) {
          const emit = () => controller.enqueue(new TextEncoder().encode('event: change\ndata: {"type":"inbox","id":null}\n\n'));
          controller.enqueue(new TextEncoder().encode(": connected\n\n"));
          window.addEventListener("inbox-arrival", emit);
          request.signal.addEventListener("abort", () => { window.removeEventListener("inbox-arrival", emit); controller.close(); }, { once: true });
        } }), { headers: { "content-type": "text/event-stream" } }));
      };
    });
    let queue = inbox(0);
    await mockRoute(page, "get", "/api/v1/me/action-inbox", () => ({ status: 200, json: queue }));
    await page.goto(path);
    await expect(page.getByRole("heading", { name: t("home.noWork.title"), exact: true })).toBeVisible();
    let loads = 0;
    page.on("load", () => { loads++; });
    queue = inbox(1);
    await page.evaluate(() => window.dispatchEvent(new Event("inbox-arrival")));
    await expect(page.locator("main [data-id]")).toHaveCount(1);
    await expect(page.getByRole("button", { name: /^새 항목 \d+건 · 새로 고침$/ })).toHaveCount(0);
    expect(loads).toBe(0);
    expect(mock.unexpected).toEqual([]);
  });
}

test("a refused queue uses the shared refusal and never paints cached work", async ({ page }) => {
  await mockScreen(page, screens[0], "populated");
  await mockRoute(page, "get", "/api/v1/me/action-inbox", { status: 403, json: failure("forbidden") });
  await page.goto("/inbox");
  await expect(page.getByRole("heading", { level: 1, name: t("home.inbox.title"), exact: true })).toBeVisible();
  await expect(page.locator("[data-id]")).toHaveCount(0);
  await expect(page.getByRole("button", { name: t("common.retry"), exact: true })).toHaveCount(0);
});

test("entering the inbox refreshes a cached setup phase after operations start", async ({ page }) => {
  await mockScreen(page, screens[0], "populated");
  await mockRoute(page, "get", "/api/v1/users/me", { status: 200, json: { ...user, tenant: { name: user.tenant!.name, phase: "SETUP", go_live_at: null } } });
  await page.goto("/");
  const open = page.getByRole("link", { name: t("home.inbox.viewInbox"), exact: true });
  await expect(open).toBeVisible();
  await mockRoute(page, "get", "/api/v1/users/me", { status: 200, json: user });
  await open.click();
  await expect(page).toHaveURL(/\/inbox$/);
  await expect(page.locator("main [data-id]")).toHaveCount(3);
  await expect(page.getByText(t("home.inbox.setup.title"), { exact: true })).toHaveCount(0);
});

for (const path of ["/", "/inbox"]) for (const width of [1440, 390]) {
  test(`queue header holds its place on ${path} at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const mock = await mockScreen(page, screens[0], "loading");
    await page.goto(path);
    const queue = page.getByRole("region", { name: t("home.inbox.title"), exact: true });
    await expect(queue.getByRole("status", { name: t("common.loading"), exact: true })).toBeVisible();
    const body = queue.locator(":scope > div").last();
    const before = (await body.boundingBox())!.y;
    mock.release();
    await expect(queue.locator("[data-id]")).toHaveCount(3);
    expect((await body.boundingBox())!.y).toBe(before);
    expect(mock.unexpected).toEqual([]);
  });
}

for (const width of [1440, 390]) {
  test(`inbox header holds its place across failed reads at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(recordShifts);
    const mock = await mockScreen(page, screens[0], "loading");
    let hold = true;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    await page.route(/\/api\/v1\/me\/action-inbox(\?|$)/, async route => {
      if (hold) await gate;
      await route.fulfill({ status: 500, contentType: "application/json", json: failure("service_unavailable") });
    });
    await page.goto("/inbox");
    const queue = page.getByRole("region", { name: t("home.inbox.title"), exact: true });
    await expect(queue.getByRole("status", { name: t("common.loading"), exact: true })).toBeVisible();
    await expect(queue.locator(":scope > div")).toHaveCount(1);
    const body = queue.locator(":scope > div").last();
    const before = (await body.boundingBox())!.y;
    hold = false;
    release();
    mock.release();
    await expect(queue.getByRole("heading", { name: t("common.loadFailed.title"), exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(queue.locator(":scope > div")).toHaveCount(1);
    expect((await body.boundingBox())!.y).toBe(before);
    await expectStable(page, `inbox load-failed at ${width}px`);
    expect(mock.unexpected).toEqual([]);
  });
}

for (const width of [1440, 390]) for (const state of ["loading", "empty", "setup", "no-grant-setup", "partial", "failed", "refused"] as const) {
  test(`inbox ${state} at ${width}px in both themes`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const mock = await mockScreen(page, screens[0], ["loading", "empty", "failed", "refused"].includes(state) ? state as "loading" | "empty" | "failed" | "refused" : "populated");
    if (state === "setup") await mockRoute(page, "get", "/api/v1/me/action-inbox", { status: 200, json: { ...inbox(1), setup: { ...checklist, phase: "SETUP" } } });
    if (state === "no-grant-setup") {
      await mockRoute(page, "get", "/api/v1/users/me", { status: 200, json: { ...user, tenant: { name: user.tenant!.name, phase: "SETUP", go_live_at: null } } });
      await mockRoute(page, "get", "/api/v1/me/action-inbox", { status: 200, json: inbox(0) });
    }
    if (state === "partial") await mockRoute(page, "get", "/api/v1/me/action-inbox", { status: 200, json: { ...inbox(1), unavailable: [{ source: "hr_register", support_reference: "inbox-source-reference" }] } });
    await page.goto("/inbox");
    const main = page.locator("main");
    await expect(main.getByRole("heading", { level: 1, name: t("home.inbox.title"), exact: true })).toBeVisible();
    if (state === "loading") await expect(main.getByRole("status", { name: t("common.loading"), exact: true })).toBeVisible();
    else if (state === "failed") await expect(main.getByRole("heading", { name: t("common.loadFailed.title"), exact: true })).toBeVisible({ timeout: 20_000 });
    else if (state === "refused") await expect(main.getByRole("region", { name: t("common.denied.title.plain"), exact: true })).toBeVisible();
    else if (state === "setup" || state === "no-grant-setup") await expect(main.getByRole("link", { name: t("shell.link.home"), exact: true })).toBeVisible();
    else if (state === "partial") {
      await expect(main.locator("[data-id]")).toHaveCount(1);
      await expect(main.getByRole("alert")).toContainText("inbox-source-reference");
    } else await expect(main.getByRole("heading", { name: t("home.noWork.title"), exact: true })).toBeVisible();
    await fits(page, `inbox ${state}`);
    await expectAxe(page, `inbox ${state} at ${width}px`);
    mock.release();
    expect(mock.unexpected).toEqual([]);
  });
}
