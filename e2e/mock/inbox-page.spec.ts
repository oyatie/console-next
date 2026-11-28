// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test, type Page } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { mockScreen } from "./screen";
import { mockRoute } from "./route";
import { checklist, failure, inbox, screenAccess, user } from "./fixtures";
import { expectAxe, fits } from "../a11y";
import { experienceState, seededExperience } from "../experience";
import { expectStable, recordShifts } from "../stability";
import { screens } from "../states/registry";

test.beforeAll(() => loadCatalog("ko"));

/** The queue's rows: Classic's queue card, or Console's worklist grid (its deadline strip repeats the same ids). */
const queueRows = (page: Page) => page.getByRole("region", { name: t("home.inbox.title"), exact: true }).locator("[data-id]")
  .or(page.getByRole("grid", { name: t("home.inbox.title"), exact: true }).locator("[data-id]"));

for (const width of [1440, 390]) for (const theme of ["light", "dark"]) {
  for (const attention_filters of [undefined, []]) {
    test(`Home keeps live server lane counts with ${attention_filters ? "empty" : "absent"} attention filters at ${width}px ${theme}`, { tag: "@baseline" }, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript(value => localStorage.setItem("console.theme", value), theme);
      const mock = await mockScreen(page, screens[0], "populated");
      const queue = inbox(8);
      queue.items = queue.items.map(item => ({ ...item, due: "2026-10-29T00:00:00Z" }));
      queue.available_filters = ["turn", "scheduled", "waiting", "deadlines", "failures"];
      queue.counts = {
        turn: { total: 31, total_is_exact: false }, scheduled: { total: 0, total_is_exact: true },
        waiting: { total: 2, total_is_exact: true }, deadlines: { total: 1, total_is_exact: true }, failures: { total: 0, total_is_exact: true },
      };
      await mockRoute(page, "get", "/api/v1/me/action-inbox", request => ({ status: 200, json: {
        ...queue, attention_filters, items: new URL(request.url()).searchParams.get("filter") === "scheduled" ? [] : queue.items,
      } }));
      await page.goto("/");
      const preview = page.getByRole("region", { name: t("home.inbox.title"), exact: true });
      await expect(preview.locator("[data-id]")).toHaveCount(5);
      await expect(preview.getByRole("group", { name: t("home.attention.label"), exact: true })).toHaveCount(0);
      const lanes = preview.getByRole("navigation", { name: t("home.lanes"), exact: true });
      for (const key of queue.available_filters) {
        const count = queue.counts[key]!;
        const label = t(count.total_is_exact ? "home.inbox.filterCount" : "home.inbox.filterCount.lower", { filter: t(`home.inbox.filter.${key}`), count: count.total });
        // My turn and its due-soon slice open 해야 할 일, the inbox's first tab.
        await expect(lanes.getByRole("link", { name: label, exact: true })).toHaveAttribute("href", key === "turn" || key === "deadlines" ? "/inbox" : `/inbox?tab=${key}`);
      }
      await fits(page, `Home live lanes at ${width}px ${theme}`);
      await expectAxe(page, `Home live lanes at ${width}px ${theme}`);
      await page.screenshot({ path: info.outputPath(`home-live-${width}-${theme}.png`), fullPage: true });
      await lanes.getByRole("link", { name: t("home.inbox.filterCount", { filter: t("home.inbox.filter.scheduled"), count: 0 }), exact: true }).click();
      await expect(page).toHaveURL(/\/inbox\?tab=scheduled$/);
      await expect(page.getByRole("heading", { name: t("home.inbox.empty.title"), exact: true })).toBeVisible();
      await page.goBack();
      await expect(page).toHaveURL(/\/$/);
      await expect(preview).toBeVisible();
      await expect(lanes.getByRole("link")).toHaveCount(queue.available_filters.length);
      await expect(lanes.locator('a[href="/inbox"]')).toHaveCount(2);
      await expect(lanes.locator('[aria-current="page"]')).toHaveCount(0);
      await expect(lanes.locator('[aria-current="true"]')).toHaveAttribute("href", "/inbox");
      expect(mock.unexpected).toEqual([]);
    });
  }

  test(`inbox shares Home rows and server URL filters at ${width}px ${theme}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(value => localStorage.setItem("console.theme", value), theme);
    const mock = await mockScreen(page, screens[0], "populated");
    const queue = inbox(8);
    queue.items = queue.items.map(item => ({ ...item, due: "2026-10-29T00:00:00Z" }));
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
    ] as const;
    await mockRoute(page, "get", "/api/v1/me/action-inbox", request => {
      const query = new URL(request.url()).searchParams;
      const offset = query.has("cursor") ? 8 : 0;
      const attentionKey = query.get("attention");
      const items = query.get("filter") === "scheduled" ? [] : attentionKey === "approvals" ? queue.items.slice(0, 2) : attentionKey === "today" ? queue.items.slice(2, 3) : attentionKey === "overdue" ? queue.items.slice(3, 4) : queue.items;
      return { status: 200, json: { ...queue, attention_filters: [...attention], items: offset ? [{ ...queue.items[0]!, id: "second-page", title: "다음 페이지 직원", age_days: 12 }] : items.map((item, index) => ({ ...item, age_days: 12, ...(index === 0 ? { context: { reason: "추가 확인 사유" } } : {}) })), next_cursor: offset || !items.length ? null : "next" } };
    });
    await page.goto("/");
    const main = page.getByRole("main");
    // How many rows Home previews, and whether a row repeats the catalog reason beside its own, is each style's own
    // (pinned below).
    await expect(queueRows(page).first()).toContainText("추가 확인 사유");
    const attentionFilters = main.getByRole("group", { name: t("home.attention.label"), exact: true });
    const shown = await queueRows(page).count();
    await expect(attentionFilters.getByRole("button")).toHaveCount(4);
    await expect(attentionFilters.getByRole("button", { name: /^전체\s*8$/ })).toHaveAttribute("aria-pressed", "true");
    await attentionFilters.getByRole("button", { name: /^결재\s*2$/ }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(queueRows(page)).toHaveCount(2);
    for (const [label, index] of [[/^오늘\s*1$/, 2], [/^기한 지남\s*1\+$/, 3]] as const) {
      const chip = attentionFilters.getByRole("button", { name: label });
      await chip.click();
      await expect(chip).toHaveAttribute("aria-pressed", "true");
      await expect(queueRows(page)).toHaveCount(1);
      await expect(queueRows(page)).toHaveAttribute("data-id", queue.items[index]!.id);
      await expect(page).toHaveURL(/\/$/);
    }
    await attentionFilters.getByRole("button", { name: /^전체\s*8$/ }).click();
    await expect(queueRows(page)).toHaveCount(shown);
    // A phone's queue columns and row commands are each style's own, and no board draws a phone's queue (Classic's
    // pinned below).
    if (width === 1440) await expect(main.getByRole("columnheader", { name: t("home.inbox.column.due"), exact: true })).toHaveCount(1);
    await expect(main.getByRole("columnheader", { name: t("home.inbox.column.owner"), exact: true })).toHaveCount(0);
    await expect(main.getByRole("button", { name: t("home.inbox.more"), exact: true })).toHaveCount(0);
    await fits(page, `Home worklist at ${width}px`);
    await expectAxe(page, `Home worklist at ${width}px ${theme}`);
    await page.screenshot({ path: info.outputPath(`home-${width}-${theme}.png`), fullPage: true });
    if (width === 390) expect(new Set(await attentionFilters.getByRole("button").evaluateAll(buttons => buttons.map(button => Math.round(button.getBoundingClientRect().top)))).size).toBe(1);
    const viewAll = main.getByRole("link", { name: t("home.inbox.viewInbox"), exact: true });
    await expect(viewAll).toHaveAttribute("href", "/inbox");
    await viewAll.click();
    await expect(page).toHaveURL(/\/inbox$/);
    await expect(page.getByRole("heading", { level: 1, name: t("home.inbox.title"), exact: true })).toBeVisible();
    await expect(page.locator("main header time[datetime]")).toBeVisible();
    const tabs = page.getByRole("navigation", { name: t("home.lanes"), exact: true });
    // 해야 할 일 · 요청한 일 · 참조 · 완료; 예정 and 실패 are chips under 해야 할 일.
    await expect(tabs.getByRole("link")).toHaveCount(4);
    const myTurn = tabs.getByRole("link", { name: /^해야 할 일\s*31\+$/ });
    await expect(myTurn).toHaveAttribute("href", "/inbox");
    await expect(myTurn).toHaveAttribute("aria-current", "page");
    const chips = page.getByRole("group", { name: t("home.inbox.tab.turn"), exact: true });
    await expect(chips.getByRole("button")).toHaveCount(2);
    const scheduled = chips.getByRole("button", { name: /^예정\s*0$/ });
    if (width === 390) expect(new Set(await tabs.getByRole("link").evaluateAll(links => links.map(link => Math.round(link.getBoundingClientRect().top)))).size).toBe(1);
    await expect(queueRows(page)).toHaveCount(8);
    await expect(queueRows(page).first()).toContainText("추가 확인 사유");
    await page.screenshot({ path: info.outputPath(`inbox-populated-${width}-${theme}.png`), fullPage: true });
    await expectAxe(page, `inbox populated at ${width}px ${theme}`);
    await main.getByRole("button", { name: t("home.inbox.more"), exact: true }).click();
    await expect(queueRows(page).and(page.locator('[data-id="second-page"]'))).toContainText("다음 페이지 직원");
    await scheduled.click();
    await expect(page).toHaveURL(/\?tab=scheduled$/);
    await expect(scheduled).toHaveAttribute("aria-pressed", "true");
    await expect(myTurn).toHaveAttribute("aria-current", "page");
    await expect(main.getByRole("heading", { name: t("home.inbox.empty.title"), exact: true })).toBeVisible();
    await page.reload();
    await expect(scheduled).toHaveAttribute("aria-pressed", "true");
    expect(await page.locator("main").evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await expectAxe(page, `inbox scheduled at ${width}px ${theme}`);
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
  const home = page.locator("main").getByRole("link", { name: t("shell.link.todo"), exact: true });
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

test("with no work or personal filter offered, Classic's Home hides the inbox link and Console's keeps it", async ({ page, storageState }) => {
  await mockScreen(page, screens[0], "empty");
  await mockRoute(page, "get", "/api/v1/me/action-inbox", { status: 200, json: { ...inbox(0), available_filters: [] } });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: t("home.noWork.title"), exact: true })).toBeVisible();
  const link = page.getByRole("link", { name: t("home.inbox.viewInbox"), exact: true });
  if (seededExperience(storageState) === "console") await expect(link).toHaveAttribute("href", "/inbox");
  else await expect(link).toHaveCount(0);
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
    if (path === "/") {
      await expect(page.getByRole("main").getByRole("status", { name: t("common.loading"), exact: true })).toBeVisible();
      // Home draws no queue, Classic's card or Console's grid, while the read is held.
      await expect(page.getByRole("region", { name: t("home.inbox.title"), exact: true }).or(page.getByRole("grid", { name: t("home.inbox.title"), exact: true }))).toHaveCount(0);
      mock.release();
      await expect(queueRows(page)).toHaveCount(3);
      expect(mock.unexpected).toEqual([]);
      return;
    }
    await expect(page.getByRole("main").getByRole("status", { name: t("common.loading"), exact: true })).toBeVisible();
    const header = page.getByRole("heading", { level: 1, name: t("home.inbox.title"), exact: true });
    const before = (await header.boundingBox())!.y;
    mock.release();
    await expect(queueRows(page)).toHaveCount(3);
    expect((await header.boundingBox())!.y).toBe(before);
    expect(mock.unexpected).toEqual([]);
  });
}

// Classic's queue card keeps its body where the loading state drew it; the card is Classic's (Console sets the queue
// straight in the page under its header band, held above).
for (const width of [1440, 390]) test(`Classic's queue card body holds its place on /inbox at ${width}px`, { tag: "@baseline" }, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  const mock = await mockScreen(page, screens[0], "loading");
  await page.goto("/inbox");
  const queue = page.getByRole("region", { name: t("home.inbox.title"), exact: true });
  await expect(queue.getByRole("status", { name: t("common.loading"), exact: true })).toBeVisible();
  const body = queue.locator(":scope > div").last();
  const before = (await body.boundingBox())!.y;
  mock.release();
  await expect(queue.locator("[data-id]")).toHaveCount(3);
  expect((await body.boundingBox())!.y).toBe(before);
});

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
    const main = page.getByRole("main");
    await expect(main.getByRole("status", { name: t("common.loading"), exact: true })).toBeVisible();
    const header = main.getByRole("heading", { level: 1, name: t("home.inbox.title"), exact: true });
    const before = (await header.boundingBox())!.y;
    hold = false;
    release();
    mock.release();
    await expect(main.getByRole("heading", { name: t("common.loadFailed.title"), exact: true })).toBeVisible({ timeout: 20_000 });
    expect((await header.boundingBox())!.y).toBe(before);
    await expectStable(page, `inbox load-failed at ${width}px`);
    expect(mock.unexpected).toEqual([]);
  });
}

for (const width of [1440, 390]) test(`Classic's queue card body holds its place across failed reads at ${width}px`, { tag: "@baseline" }, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  const mock = await mockScreen(page, screens[0], "loading");
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(/\/api\/v1\/me\/action-inbox(\?|$)/, async route => {
    await gate;
    await route.fulfill({ status: 500, contentType: "application/json", json: failure("service_unavailable") });
  });
  await page.goto("/inbox");
  const queue = page.getByRole("region", { name: t("home.inbox.title"), exact: true });
  await expect(queue.getByRole("status", { name: t("common.loading"), exact: true })).toBeVisible();
  await expect(queue.locator(":scope > div")).toHaveCount(1);
  const body = queue.locator(":scope > div").last();
  const before = (await body.boundingBox())!.y;
  release();
  mock.release();
  await expect(queue.getByRole("heading", { name: t("common.loadFailed.title"), exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(queue.locator(":scope > div")).toHaveCount(1);
  expect((await body.boundingBox())!.y).toBe(before);
});

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
    else if (state === "setup" || state === "no-grant-setup") await expect(main.getByRole("link", { name: t("shell.link.todo"), exact: true })).toBeVisible();
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

for (const width of [1440, 390]) test(`Home paints the receipt with a refused inbox at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 });
  await mockScreen(page, screens[0], "refused");
  await mockRoute(page, "get", "/api/v1/access/me", { status: 200, json: { ...screenAccess("/setup/go-live"), is_ops: true } });
  let requested = false;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await mockRoute(page, "get", "/api/v1/settings", { status: 200, json: { can_change: false, items: [{ key: "onboarding.receipt_days", value: 2, default: 2,
    kind: { type: "int", unit: "days" }, looser_when: "higher", governance: "tenant",
    legal_basis: null, version: "code_default", effective_from: null, scheduled: [], source: { layer: "code_default", scope_entity_id: null }, chain: [],
  }] } });
  await mockRoute(page, "get", "/api/v1/onboarding/checklist", async () => {
    requested = true;
    await held;
    return { status: 200, json: { ...checklist, go_live_at: new Date().toISOString() } };
  });
  try {
    await page.goto("/");
    const queue = page.getByRole("main").getByRole("region", { name: t("common.denied.title.plain"), exact: true });
    await expect.poll(() => requested).toBe(true);
    await expect(page.getByRole("main").getByRole("status", { name: t("common.loading"), exact: true })).toBeVisible();
    await expect(queue).toHaveCount(0);
    for (const theme of ["light", "dark"]) {
      await page.locator("html").evaluate((el, value) => el.dataset.theme = value, theme);
      await page.screenshot({ path: info.outputPath(`home-receipt-pending-${width}-${theme}.png`), fullPage: true });
    }
    release();
    await expect(queue).toBeVisible();
    const before = (await queue.boundingBox())!.y;
    await expect(page.locator("[data-setup-receipt]")).toBeVisible();
    await expect(page.getByRole("link", { name: t("setup.receipt.open"), exact: true })).toBeVisible();
    await expect(page.getByText(t("setup.receipt.started.title"), { exact: true })).toBeVisible();
    expect((await queue.boundingBox())!.y).toBe(before);
    for (const theme of ["light", "dark"]) {
      await page.locator("html").evaluate((el, value) => el.dataset.theme = value, theme);
      await fits(page, `Home receipt at ${width}px ${theme}`);
      await expectAxe(page, `Home receipt at ${width}px ${theme}`);
      await page.screenshot({ path: info.outputPath(`home-receipt-${width}-${theme}.png`), fullPage: true });
    }
    expect((await queue.boundingBox())!.y).toBe(before);
  } finally { release(); }
});

for (const width of [1440, 390]) test(`Home without a receipt keeps the inbox at its base position at ${width}px`, { tag: "@baseline" }, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 });
  const mock = await mockScreen(page, screens[0], "populated");
  await page.goto("/");
  const queue = page.getByRole("region", { name: t("home.inbox.title"), exact: true });
  await expect(queue.locator("[data-id]")).toHaveCount(3);
  await expect(page.locator("[data-setup-receipt], [data-phase-band]")).toHaveCount(0);
  expect((await queue.boundingBox())!.y).toBe(145.5);
  for (const theme of ["light", "dark"]) {
    await page.locator("html").evaluate((el, value) => el.dataset.theme = value, theme);
    await fits(page, `Home without receipt at ${width}px ${theme}`);
    await expectAxe(page, `Home without receipt at ${width}px ${theme}`);
    await page.screenshot({ path: info.outputPath(`home-no-receipt-${width}-${theme}.png`), fullPage: true });
  }
  expect(mock.unexpected).toEqual([]);
});

// Home previews the queue's first rows: five in Classic; ten in Console, as d-home draws them before its more button.
// Console's Home draws no lane navigation and no receipt band without a receipt.
test("Classic Home previews five queue rows", { tag: "@baseline" }, async ({ page }) => {
  await mockScreen(page, screens[0], "populated");
  await mockRoute(page, "get", "/api/v1/me/action-inbox", { status: 200, json: inbox(12) });
  await page.goto("/");
  await expect(page.getByRole("region", { name: t("home.inbox.title"), exact: true }).locator("[data-id]")).toHaveCount(5);
});

test.describe("console look", () => {
  test.use({ storageState: experienceState("console") });
  for (const width of [1440, 390]) test(`Console Home lists up to ten queue rows with no lanes or receipt band at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const mock = await mockScreen(page, screens[0], "populated");
    await mockRoute(page, "get", "/api/v1/me/action-inbox", { status: 200, json: inbox(12) });
    await page.goto("/");
    await expect(page.getByRole("grid", { name: t("home.inbox.title"), exact: true }).locator("[data-id]")).toHaveCount(10);
    await expect(page.getByRole("navigation", { name: t("home.lanes"), exact: true })).toHaveCount(0);
    await expect(page.locator("[data-setup-receipt], [data-phase-band]")).toHaveCount(0);
    expect(mock.unexpected).toEqual([]);
  });
});

// Classic stacks every reason line under a queue row; Console's reason cell holds one line, the item's own reason ahead
// of the catalog's. The home board draws one reason per row but not which, so the Console value is the render's.
const OWN_REASON = "own reason";
async function openOwnReason(page: Page) {
  await mockScreen(page, screens[0], "populated");
  const data = inbox(1);
  data.items = data.items.map(item => ({ ...item, due: "2026-10-29T00:00:00Z", context: { reason: OWN_REASON } }));
  await mockRoute(page, "get", "/api/v1/me/action-inbox", { status: 200, json: data });
  await page.goto("/");
  const row = queueRows(page).first();
  await expect(row).toContainText(OWN_REASON);
  return row;
}

test("Classic stacks the catalog reason and the item's own under a queue row", { tag: "@baseline" }, async ({ page }) => {
  await expect(await openOwnReason(page)).toContainText(t("home.inbox.reason.contract_renewal"));
});

test("Classic's phone queue keeps the due column and each row's command", { tag: "@baseline" }, async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await openOwnReason(page);
  const queue = page.getByRole("region", { name: t("home.inbox.title"), exact: true });
  await expect(queue.getByRole("columnheader", { name: t("home.inbox.column.due"), exact: true })).toHaveCount(1);
  await expect(queue.getByRole("link", { name: t("home.inbox.action.contract"), exact: true }).first()).toBeVisible();
});

test.describe("console look", () => {
  test.use({ storageState: experienceState("console") });
  test("Console's reason cell shows only the item's own reason", async ({ page }) => {
    await expect(await openOwnReason(page)).not.toContainText(t("home.inbox.reason.contract_renewal"));
  });
});
