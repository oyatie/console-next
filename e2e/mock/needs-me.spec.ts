// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { expectAxe, fits } from "../a11y";
import { expectStable, recordShifts } from "../stability";
import { screens } from "../states/registry";
import { failure, inbox, screenAccess, token } from "./fixtures";
import { mockRoute } from "./route";
import { mockScreen } from "./screen";

test.beforeAll(() => loadCatalog("ko"));

for (const width of [1440, 1024, 390]) for (const theme of ["light", "dark"]) {
  for (const state of ["populated", "zero", "inexact", "failed", "refused"] as const) {
    test(`header task panel ${state} at ${width}px ${theme}`, async ({ page }, info) => {
      test.slow(state === "populated", "Checks three tenant pages and their panels.");
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript(value => localStorage.setItem("console.theme", value), theme);
      const mock = await mockScreen(page, screens[0], "populated");
      const queue = inbox(state === "zero" ? 0 : 3);
      queue.counts.turn = { total: state === "inexact" ? 12 : queue.total, total_is_exact: state !== "inexact" };
      // Other lanes and returned row counts must never inflate the turn badge.
      queue.counts.waiting = { total: 40, total_is_exact: true };
      let reads = 0;
      await mockRoute(page, "get", "/api/v1/me/action-inbox", request => {
        if (new URL(request.url()).searchParams.get("filter") === "turn") reads++;
        return state === "failed" ? { status: 500, json: failure("service_unavailable") }
          : state === "refused" ? { status: 403, json: failure("forbidden") } : { status: 200, json: queue };
      });
      for (const path of state === "populated" ? ["/", "/people", "/org"] : ["/people"]) {
        reads = 0;
        await page.goto(path);
        await expect(page.locator("main h1").first()).toBeVisible({ timeout: 20_000 });
        const surface = path === "/" ? "home" : path.slice(1);
        await page.screenshot({ path: info.outputPath(`${surface}-arrival-${width}-${theme}.png`), fullPage: true });
        const unknown = state === "failed" || state === "refused";
        const label = unknown ? "업무함 · 확인 불가" : state === "zero" ? t("shell.needsMe") : t(state === "inexact" ? "shell.needsMe.countMore" : "shell.needsMe.count", { count: state === "inexact" ? 12 : 3 });
        const header = page.locator("header.top");
        const trigger = header.getByRole("button", { name: label, exact: true });
        await expect(trigger).toBeVisible({ timeout: 20_000 });
        if (unknown || state === "zero") await expect(trigger.locator("[data-count]")).toHaveCount(0);
        else await expect(trigger.locator("[data-count]")).toHaveText(state === "inexact" ? "12+" : "3");
        await expect(header.getByRole("button", { name: t("shell.jumpLabel"), exact: true })).toBeVisible();
        if (width === 390) {
          await expect(header.getByRole("button", { name: t("shell.menu"), exact: true })).toBeVisible();
          await expect(trigger.getByText(t("home.inbox.title"), { exact: true })).toBeHidden();
        }
        await fits(page, `header ${state} ${path}`);
        expect(await header.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
        await expectAxe(page, `header ${state} ${path}`);
        if (!unknown) expect(reads).toBe(1);
        await page.screenshot({ path: info.outputPath(`${surface}-header-${width}-${theme}.png`), fullPage: true });
        await trigger.click();
        const panel = page.getByRole("dialog", { name: t("shell.needsMe"), exact: true });
        await expect(panel).toBeVisible();
        const fullPage = panel.getByRole("link", { name: t("home.inbox.viewInbox"), exact: true });
        await expect(fullPage).toHaveAttribute("href", "/inbox");
        if (unknown) {
          await expect(panel.getByText(t("home.inbox.empty.title"), { exact: true })).toHaveCount(0);
          if (state === "refused") {
            await expect(panel.getByRole("status")).toHaveText("업무함에 접근 권한이 없습니다");
            await expect(panel.getByText(t("common.denied.title.plain"), { exact: true })).toHaveCount(0);
            await expect(panel.getByRole("link")).toHaveCount(1);
          } else await expect(panel.getByRole("heading", { name: t("common.loadFailed.title"), exact: true })).toBeVisible({ timeout: 20_000 });
          await expect(trigger).toHaveAccessibleName(label);
        } else if (state === "zero") await expect(panel.getByText(t("home.inbox.empty.title"), { exact: true })).toBeVisible();
        else await expect(panel.getByRole("link", { name: /검증직원/ })).toHaveCount(3);
        await expectAxe(page, `task panel ${state} ${path}`);
        await page.screenshot({ path: info.outputPath(`${surface}-panel-${width}-${theme}.png`), fullPage: true });
        await page.keyboard.press("Escape");
        await expect(panel).toHaveCount(0);
        await expect(trigger).toBeFocused();
        if (state === "populated") {
          await trigger.click();
          await fullPage.click();
          await expect(page).toHaveURL(/\/inbox$/);
          await expect(page.locator("main h1")).toBeVisible();
        }
      }
      expect(mock.unexpected).toEqual([]);
    });
  }
}


test("platform header never mounts or reads the tenant task panel", async ({ page }) => {
  const mock = await mockScreen(page, screens[0], "populated");
  const auth = token();
  const [header, payload, signature] = auth.access_token.split(".");
  auth.access_token = `${header}.${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload!, "base64url").toString()), platform: true })).toString("base64url")}.${signature}`;
  await mockRoute(page, "post", "/api/v1/auth/token/refresh", { status: 200, json: auth });
  await mockRoute(page, "get", "/api/platform/orgs", { status: 200, json: [] });
  await mockRoute(page, "get", "/api/platform/ops", { status: 200, json: { tenants: [], notices: [] } });
  const chunks: string[] = [];
  let reads = 0;
  page.on("request", request => {
    const path = new URL(request.url()).pathname;
    if (path === "/api/v1/me/action-inbox") reads++;
    if (/\/assets\/needs-me-[^/]+\.js$/.test(path)) chunks.push(path);
  });
  await page.goto("/platform");
  await expect(page.locator("header.top").getByRole("button", { name: t("shell.logout"), exact: true })).toBeVisible();
  await page.waitForLoadState("networkidle");
  await expect(page.locator("#top-needs-me")).toHaveCount(0);
  expect(chunks).toEqual([]);
  expect(reads).toBe(0);
  expect(mock.unexpected).toEqual([]);
});

test("Home shares its arrival read and refreshes held work after attention changes", async ({ page }) => {
  const mock = await mockScreen(page, screens[0], "populated");
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
  const queue = inbox(3);
  queue.attention_filters = ["all", "approvals", "today", "overdue"].map(key => ({ key: key as "all" | "approvals" | "today" | "overdue", total: 3, total_is_exact: true }));
  let reads = 0;
  await mockRoute(page, "get", "/api/v1/me/action-inbox", () => { reads++; return { status: 200, json: queue }; });
  await page.goto("/");
  await expect(page.locator("main h1")).toBeVisible({ timeout: 20_000 });
  const trigger = page.locator("#top-needs-me");
  await expect(trigger).toHaveAccessibleName(t("shell.needsMe.count", { count: 3 }));
  expect(reads).toBe(1);
  await page.getByRole("group", { name: "확인 필요", exact: true }).getByRole("button", { name: /^결재/ }).click();
  await expect.poll(() => reads).toBe(2);
  queue.counts.turn = { total: 7, total_is_exact: true };
  await page.evaluate(() => window.dispatchEvent(new Event("inbox-arrival")));
  await page.getByRole("button", { name: t("live.list.new_rows", { count: 1 }), exact: true }).click();
  await expect(trigger).toHaveAccessibleName(t("shell.needsMe.count", { count: 7 }));
  expect(mock.unexpected).toEqual([]);
});

for (const filter of ["all", "waiting", "scheduled", "turn"] as const) {
  test(`inbox ${filter} shares arrival counts and opens only my turn in the header panel`, async ({ page }) => {
    const mock = await mockScreen(page, screens[0], "populated");
    const reads: string[] = [];
    await mockRoute(page, "get", "/api/v1/me/action-inbox", request => {
      const selected = new URL(request.url()).searchParams.get("filter")!;
      reads.push(selected);
      const queue = inbox(3);
      return { status: 200, json: selected === "turn" ? queue : { ...queue, items: queue.items.map(item => ({ ...item, title: "다른 차례 업무", lane: "waiting" as const })) } };
    });
    await page.goto(`/inbox?tab=${filter}`);
    await expect(page.locator("main h1")).toBeVisible({ timeout: 20_000 });
    const trigger = page.locator("#top-needs-me");
    await expect(trigger).toHaveAccessibleName(t("shell.needsMe.count", { count: 3 }));
    expect(reads).toEqual([filter]);
    await trigger.click();
    const panel = page.getByRole("dialog", { name: t("shell.needsMe"), exact: true });
    await expect(panel.getByRole("link", { name: /검증직원/ })).toHaveCount(3);
    await expect(panel.getByText("다른 차례 업무", { exact: true })).toHaveCount(0);
    expect(reads).toEqual(filter === "turn" ? [filter] : [filter, "turn"]);
    expect(mock.unexpected).toEqual([]);
  });
}


test("header reserves its space before the task menu loads", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.addInitScript(recordShifts);
  const mock = await mockScreen(page, screens[0], "populated");
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route(/\/assets\/needs-me-[^/]+\.js$/, async route => { await held; await route.continue(); });
  await page.goto("/");
  try {
    await expect(page.locator("main [data-id]")).toHaveCount(3);
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => window.__shifts?.splice(0));
  } finally { release(); }
  await expect(page.locator("#top-needs-me")).toHaveAccessibleName(t("shell.needsMe.count", { count: 3 }));
  await fits(page, "late task menu");
  await expectStable(page, "late task menu");
  expect(mock.unexpected).toEqual([]);
});

for (const width of [641, 700, 767, 768, 769, 1024, 1279]) for (const theme of ["light", "dark"]) {
  test(`tablet header uses available width at ${width}px ${theme}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(value => localStorage.setItem("console.theme", value), theme);
    const mock = await mockScreen(page, screens[0], "populated");
    await page.goto("/people");
    const header = page.locator("header.top");
    await expect(header.locator("#top-needs-me [data-count]")).toHaveText("3", { timeout: 20_000 });
    const prompt = header.locator(".top__jumpText");
    await expect(prompt).toBeVisible();
    expect(await prompt.evaluate(el => el.clientWidth / el.scrollWidth)).toBeGreaterThanOrEqual(1);
    await expect(header.locator(".top__jump svg")).toBeVisible();
    expect((await header.locator(".top__jump").boundingBox())!.width).toBeGreaterThanOrEqual(40);
    const logout = header.getByRole("button", { name: t("shell.logout"), exact: true });
    await expect(logout).toBeVisible();
    expect(await logout.evaluate(el => Number.parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThan(0);
    const spacer = await header.locator(".top__spacer").boundingBox();
    if (spacer!.width > 1) {
      const jump = header.locator(".top__jump");
      // Spare space is valid only after the search field reaches its desktop basis.
      expect((await jump.boundingBox())!.width).toBeGreaterThanOrEqual(await jump.evaluate(el => Number.parseFloat(getComputedStyle(el).flexBasis)));
    }
    await fits(page, "tablet header");
    expect(await header.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`people-header-${width}-${theme}.png`), fullPage: true });
    expect(mock.unexpected).toEqual([]);
  });
}

for (const width of [1440, 1024, 390]) for (const theme of ["light", "dark"]) {
  test(`task count is loading until answered at ${width}px ${theme}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(value => localStorage.setItem("console.theme", value), theme);
    const mock = await mockScreen(page, screens[0], "populated");
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    await page.route("**/api/v1/me/action-inbox?*", async route => {
      await held;
      await route.fulfill({ status: 200, json: inbox(3) });
    });
    await page.goto("/people");
    const trigger = page.locator("#top-needs-me");
    try {
      await expect(trigger).toHaveAccessibleName("업무함 · 불러오는 중…", { timeout: 20_000 });
      await expect(trigger.locator("[data-count]")).toHaveCount(0);
      await trigger.click();
      const panel = page.getByRole("dialog", { name: t("shell.needsMe"), exact: true });
      await expect(panel.getByRole("status")).toHaveAccessibleName(t("common.loading"));
      await fits(page, "loading task panel");
      await expectAxe(page, "loading task panel");
      await page.screenshot({ path: info.outputPath(`people-loading-${width}-${theme}.png`), fullPage: true });
    } finally { release(); }
    await expect(trigger).toHaveAccessibleName(t("shell.needsMe.count", { count: 3 }));
    expect(mock.unexpected).toEqual([]);
  });
}

test("task badge survives navigation without rereading and loads panel code only when opened", async ({ page }) => {
  await page.clock.install();
  const mock = await mockScreen(page, screens[0], "populated");
  const people = screenAccess("/people"), org = screenAccess("/org");
  await mockRoute(page, "get", "/api/v1/access/me", { status: 200, json: {
    ...people, decisions: { ...people.decisions, ...org.decisions }, entries: [...people.entries, ...org.entries],
  } });
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await mockRoute(page, "get", "/api/v1/me/action-inbox", async request => {
    if (!new URL(request.url()).searchParams.has("attention")) await held;
    return { status: 200, json: inbox(3) };
  });
  const chunks: string[] = [];
  let reads = 0;
  page.on("request", request => {
    const path = new URL(request.url()).pathname;
    if (path === "/api/v1/me/action-inbox") reads++;
    if (/\/assets\/needs-me-panel-[^/]+\.js$/.test(path)) chunks.push(request.url());
  });
  await page.goto("/");
  const trigger = page.locator("#top-needs-me");
  await expect(trigger).toHaveAccessibleName(t("shell.needsMe.count", { count: 3 }));
  expect(chunks).toEqual([]);
  const badge = await trigger.elementHandle();
  try {
    await page.locator('#rail a[href="/people"]').click();
    await expect(page).toHaveURL(/\/people$/);
    await expect(page.locator("main h1").first()).toBeVisible();
    await expect(trigger).toHaveAccessibleName(t("shell.needsMe.count", { count: 3 }));
    expect(reads).toBe(2);
  } finally { release(); }
  for (const path of ["/org", "/people"]) {
    await page.locator(`#rail a[href="${path}"]`).click();
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    await expect(page.locator("main h1").first()).toBeVisible();
    await page.clock.runFor(1_000);
    expect(reads).toBe(2);
    expect(await badge!.evaluate(el => el.isConnected)).toBe(true);
    await expect(trigger).toHaveAccessibleName(t("shell.needsMe.count", { count: 3 }));
  }
  expect(chunks).toEqual([]);
  await trigger.click();
  const panel = page.getByRole("dialog", { name: t("shell.needsMe"), exact: true });
  await expect(panel.getByRole("link", { name: /검증직원/ })).toHaveCount(3);
  expect(chunks).toHaveLength(1);
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await trigger.click();
  await expect(panel.getByRole("link", { name: /검증직원/ })).toHaveCount(3);
  expect(chunks).toHaveLength(1);
  expect(mock.unexpected).toEqual([]);
});
