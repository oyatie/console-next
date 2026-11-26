// SPDX-License-Identifier: LicenseRef-Proprietary
import { expectSignedIn, needsMe, openNav, shell } from "../shell";
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { fmtNumber } from "@console/i18n/format";
import { expectAxe, fits } from "../a11y";
import { clearShifts, expectStable, recordShifts } from "../stability";
import { go } from "../flows";
import { screens } from "../states/registry";
import { failure, inbox, screenAccess, token } from "./fixtures";
import { mockRoute } from "./route";
import { mockScreen } from "./screen";
import { EXPERIENCE_KEY } from "../../apps/web/src/lib/prefs";
import { experienceState } from "../experience";

test.beforeAll(() => loadCatalog("ko"));

// Populated and zero pin Classic's task button and its panel. Inexact and the unknown states keep running in the shipped
// style: Console's link drops the "+" of an inexact count and reads plain to-dos while the count is unknown.
for (const width of [1440, 1024, 390]) for (const theme of ["light", "dark"]) {
  for (const state of ["populated", "zero", "inexact", "failed", "refused"] as const) {
    test(`header task panel ${state} at ${width}px ${theme}${state === "populated" || state === "zero" ? " @baseline" : ""}`, async ({ page }, info) => {
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
        const label = unknown ? t("shell.needsMe.unknown") : state === "zero" ? t("home.inbox.title") : t(state === "inexact" ? "shell.needsMe.countMore" : "shell.needsMe.count", { count: state === "inexact" ? 12 : 3 });
        const header = shell(page).banner;
        const trigger = header.getByRole("button", { name: label, exact: true });
        await expect(trigger).toBeVisible({ timeout: 20_000 });
        if (unknown || state === "zero") await expect(trigger.locator("[data-count]")).toHaveCount(0);
        else await expect(trigger.locator("[data-count]")).toHaveText(state === "inexact" ? "12+" : "3");
        await expect(header.getByRole("button", { name: t(width === 1440 ? "shell.jump" : "shell.jumpLabel"), exact: true })).toBeVisible();
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
            await expect(panel.getByRole("status")).toHaveText(t("shell.needsMe.denied"));
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
          // 해야 할 일 re-reads my turn on arrival: let it land before the next page counts its own read.
          const arrived = page.waitForResponse(response => new URL(response.url()).pathname === "/api/v1/me/action-inbox");
          await fullPage.click();
          await expect(page).toHaveURL(/\/inbox$/);
          await expect(page.locator("main h1")).toBeVisible();
          await (await arrived).finished();
          await expect(page.getByRole("region", { name: t("home.inbox.title"), exact: true }).locator("[data-id]")).toHaveCount(3);
        }
      }
      expect(mock.unexpected).toEqual([]);
    });
  }
}

// d-home.dc.html:34 draws Console's count on the bar's to-do link, which opens the to-do list. 1024 has no board and
// pins the render; no board draws an admin's bar at 390.
test.describe("console bar", () => {
  test.use({ storageState: experienceState("console") });
  for (const width of [1440, 1024]) for (const state of ["populated", "zero"] as const) {
    test(`console bar to-do link reads the ${state} count at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      const mock = await mockScreen(page, screens[0], "populated");
      const queue = inbox(state === "zero" ? 0 : 3);
      queue.counts.turn = { total: queue.total, total_is_exact: true };
      // Other lanes and returned row counts must never inflate the turn badge.
      queue.counts.waiting = { total: 40, total_is_exact: true };
      let reads = 0;
      await mockRoute(page, "get", "/api/v1/me/action-inbox", request => {
        if (new URL(request.url()).searchParams.get("filter") === "turn") reads++;
        return { status: 200, json: queue };
      });
      for (const path of state === "populated" ? ["/", "/people", "/org"] : ["/people"]) {
        reads = 0;
        await page.goto(path);
        await expect(page.locator("main h1").first()).toBeVisible({ timeout: 20_000 });
        const link = needsMe(page);
        await expect(link).toHaveAccessibleName(state === "zero" ? t("shell.link.todo") : t("shell.needsMe.count", { count: 3 }));
        await expect(link.locator("data")).toHaveText(state === "zero" ? [] : ["3"]);
        await expect(link).toHaveAttribute("href", "/");
        if (width === 1440) expect(await shell(page).searchText.evaluate(el => el.clientWidth / el.scrollWidth)).toBeGreaterThanOrEqual(1);
        expect(reads).toBe(1);
        await fits(page, `console bar ${state} ${path}`);
        expect(await shell(page).banner.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
        await expectAxe(page, `console bar ${state} ${path}`);
      }
      expect(mock.unexpected).toEqual([]);
    });
  }
});

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
  await expectSignedIn(page);
  await page.waitForLoadState("networkidle");
  await expect(needsMe(page)).toHaveCount(0);
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
  const trigger = needsMe(page);
  await expect(trigger).toHaveAccessibleName(t("shell.needsMe.count", { count: 3 }));
  expect(reads).toBe(1);
  await page.getByRole("group", { name: t("home.attention.label"), exact: true }).getByRole("button", { name: t("home.attention.approvals") }).click();
  await expect.poll(() => reads).toBe(2);
  queue.counts.turn = { total: 7, total_is_exact: true };
  await page.evaluate(() => window.dispatchEvent(new Event("inbox-arrival")));
  await page.getByRole("button", { name: t("live.list.new_rows", { count: 1 }), exact: true }).click();
  await expect(trigger).toHaveAccessibleName(t("shell.needsMe.count", { count: 7 }));
  expect(mock.unexpected).toEqual([]);
});

for (const experience of ["baseline", "console"] as const) test(`the task count never steps back to an older copy while a page re-reads it in ${experience}${experience === "baseline" ? " @baseline" : ""}`, async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(recordShifts);
  if (experience === "console") await page.addInitScript(key => localStorage.setItem(key, "console"), EXPERIENCE_KEY);
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
  let turn = 5;
  let hold: Promise<void> | undefined;
  await mockRoute(page, "get", "/api/v1/me/action-inbox", async () => {
    await hold;
    const queue = inbox(3);
    queue.counts.turn = { total: turn, total_is_exact: turn < 100 };
    return { status: 200, json: queue };
  });
  const nav = page.getByRole("navigation", { name: t("shell.nav"), exact: true });
  // Baseline shows the count on the header's task button; the console on the rail's Home link.
  const trigger = page.locator("#top-needs-me");
  const shows = (count: number, options?: { timeout: number }) => experience === "baseline"
    ? expect(trigger).toHaveAccessibleName(t(count < 100 ? "shell.needsMe.count" : "shell.needsMe.countMore", { count }), options)
    : expect(nav.getByRole("link", { name: t("shell.link.todo") }).getByText(count < 100 ? fmtNumber(count) : `${fmtNumber(count)}+`, { exact: true })).toBeVisible(options);
  await page.goto("/people");
  await shows(5, { timeout: 20_000 });
  turn = 125;
  await go(page, "/");
  await shows(125);
  // A change arrives on Home: the roster's own copy of the count is marked stale there, not re-read (nothing shows it).
  await page.evaluate(() => window.dispatchEvent(new Event("inbox-arrival")));
  await page.getByRole("button", { name: t("live.list.new_rows", { count: 1 }), exact: true }).click();
  await shows(125);
  const held = Promise.withResolvers<void>();
  hold = held.promise;
  await page.evaluate(clearShifts);
  try {
    await nav.getByRole("link", { name: t("shell.link.people"), exact: true }).click();
    await expect(page).toHaveURL(/\/people$/);
    await expect(page.getByRole("main").locator("h1").first()).toBeVisible();
    // Arriving re-reads that stale copy: the count keeps the newer one it showed meanwhile.
    await shows(125);
  } finally { held.resolve(); }
  await shows(125);
  await expectStable(page, "task count re-read on arrival");
  expect(mock.unexpected).toEqual([]);
});

// 참조 and 완료 are lists of their own: the page keeps my turn read, so the badge shares it. Old 전체 links land on my turn.
for (const [tab, filter] of [["all", "turn"], ["waiting", "waiting"], ["scheduled", "scheduled"], ["turn", "turn"], ["reference", "turn"], ["done", "turn"]] as const) for (const headerPanel of [false, true]) {
  test(headerPanel ? `inbox ${tab} shares arrival counts and opens only my turn in the header panel @baseline` : `inbox ${tab} shares arrival counts with the to-do entry`, async ({ page }) => {
    const mock = await mockScreen(page, screens[0], "populated");
    const reads: string[] = [];
    await mockRoute(page, "get", "/api/v1/me/action-inbox/reference", { status: 200, json: { items: [], next_cursor: null } });
    await mockRoute(page, "get", "/api/v1/me/action-inbox/done", { status: 200, json: { items: [], next_cursor: null } });
    await mockRoute(page, "get", "/api/v1/me/action-inbox", request => {
      const selected = new URL(request.url()).searchParams.get("filter")!;
      reads.push(selected);
      const queue = inbox(3);
      return { status: 200, json: selected === "turn" ? queue : { ...queue, items: queue.items.map(item => ({ ...item, title: "다른 차례 업무", lane: "waiting" as const })) } };
    });
    await page.goto(`/inbox?tab=${tab}`);
    await expect(page.locator("main h1")).toBeVisible({ timeout: 20_000 });
    const trigger = needsMe(page);
    await expect(trigger).toHaveAccessibleName(t("shell.needsMe.count", { count: 3 }));
    // 참조 also reads the notices view for the grants I have not confirmed; it never feeds the badge.
    const queueReads = () => reads.filter(read => read !== "notices");
    expect(queueReads()).toEqual([filter]);
    expect(reads.includes("notices")).toBe(tab === "reference");
    if (!headerPanel) {
      expect(mock.unexpected).toEqual([]);
      return;
    }
    await trigger.click();
    const panel = page.getByRole("dialog", { name: t("shell.needsMe"), exact: true });
    await expect(panel.getByRole("link", { name: /검증직원/ })).toHaveCount(3);
    await expect(panel.getByText("다른 차례 업무", { exact: true })).toHaveCount(0);
    expect(queueReads()).toEqual(filter === "turn" ? [filter] : [filter, "turn"]);
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
  await expect(needsMe(page)).toHaveAccessibleName(t("shell.needsMe.count", { count: 3 }));
  await fits(page, "late task menu");
  await expectStable(page, "late task menu");
  expect(mock.unexpected).toEqual([]);
});

for (const width of [641, 700, 767, 768, 769, 1024, 1279]) for (const theme of ["light", "dark"]) {
  test(`tablet header uses available width at ${width}px ${theme} @baseline`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(value => localStorage.setItem("console.theme", value), theme);
    const mock = await mockScreen(page, screens[0], "populated");
    await page.goto("/people");
    const header = shell(page).banner;
    await expect(header.locator("#top-needs-me [data-count]")).toHaveText("3", { timeout: 20_000 });
    const prompt = shell(page).searchText;
    await expect(prompt).toBeVisible();
    expect(await prompt.evaluate(el => el.clientWidth / el.scrollWidth)).toBeGreaterThanOrEqual(1);
    await expect(shell(page).search.locator("svg")).toBeVisible();
    expect((await shell(page).search.boundingBox())!.width).toBeGreaterThanOrEqual(40);
    const logout = header.getByRole("button", { name: t("shell.logout"), exact: true });
    await expect(logout).toBeVisible();
    expect(await logout.evaluate(el => Number.parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThan(0);
    const spacer = await shell(page).spacer.boundingBox();
    if (spacer!.width > 1) {
      const jump = shell(page).search;
      // Spare space is valid only after the search field reaches its desktop basis.
      expect((await jump.boundingBox())!.width).toBeGreaterThanOrEqual(await jump.evaluate(el => Number.parseFloat(getComputedStyle(el).flexBasis)));
    }
    await fits(page, "tablet header");
    expect(await header.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`people-header-${width}-${theme}.png`), fullPage: true });
    expect(mock.unexpected).toEqual([]);
  });
}

for (const width of [768, 769]) {
  test(`tablet header fits prompt with fallback font at ${width}px dark @baseline`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(value => localStorage.setItem("console.theme", value), "dark");
    const mock = await mockScreen(page, screens[0], "populated");
    await page.route("**/*.woff2", route => route.abort());
    await page.goto("/people");
    await expect(page.locator("html")).toHaveAttribute("data-font-fallback", "");
    const header = shell(page).banner;
    await expect(header.locator("#top-needs-me [data-count]")).toHaveText("3", { timeout: 20_000 });
    const prompt = shell(page).searchText;
    await expect(prompt).toBeVisible();
    const metrics = await prompt.evaluate(el => {
      const range = document.createRange();
      range.selectNodeContents(el);
      return {
        clientWidth: el.clientWidth,
        scrollWidth: el.scrollWidth,
        textWidth: range.getBoundingClientRect().width,
      };
    });
    expect(metrics.clientWidth / metrics.scrollWidth).toBeGreaterThanOrEqual(1);
    expect(metrics.clientWidth - metrics.textWidth).toBeGreaterThanOrEqual(15);
    const logout = header.getByRole("button", { name: t("shell.logout"), exact: true });
    await expect(logout).toBeVisible();
    expect(await logout.evaluate(el => Number.parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThan(0);
    await fits(page, "tablet fallback font header");
    expect(await header.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    expect(mock.unexpected).toEqual([]);
  });
}

// No board draws the bar between 390 and 1440, so this pins Console's render: its phone bar below 768 and its desk bar,
// with the search control, from 768. The render shortens the search hint with an ellipsis there, so it is not pinned whole.
test.describe("console tablet bar", () => {
  test.use({ storageState: experienceState("console") });
  for (const [width, fallback] of [[641, false], [700, false], [767, false], [768, false], [769, false], [1024, false], [1279, false], [768, true], [769, true]] as const) {
    test(`console tablet bar fits at ${width}px${fallback ? " with fallback font" : ""}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      const mock = await mockScreen(page, screens[0], "populated");
      if (fallback) await page.route("**/*.woff2", route => route.abort());
      await page.goto("/people");
      if (fallback) await expect(page.locator("html")).toHaveAttribute("data-font-fallback", "");
      await expect(needsMe(page).locator("data")).toHaveText("3", { timeout: 20_000 });
      if (width >= 768) {
        await expect(shell(page).searchText).toBeVisible();
        await expect(shell(page).search.locator("svg")).toBeVisible();
        expect((await shell(page).search.boundingBox())!.width).toBeGreaterThanOrEqual(40);
      }
      await fits(page, `console tablet bar ${width}`);
      expect(await shell(page).banner.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      expect(mock.unexpected).toEqual([]);
    });
  }
});

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
      await expect(trigger).toHaveAccessibleName(t("shell.needsMe.loading"), { timeout: 20_000 });
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

for (const headerPanel of [false, true]) test(headerPanel ? "task badge survives navigation without rereading and loads panel code only when opened @baseline" : "task badge survives navigation without rereading", async ({ page }) => {
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
  const trigger = needsMe(page);
  await expect(trigger).toHaveAccessibleName(t("shell.needsMe.count", { count: 3 }));
  expect(chunks).toEqual([]);
  const badge = await trigger.elementHandle();
  const link = async (path: "/people" | "/org") => (await openNav(page)).getByRole("link", { name: t(path === "/org" ? "shell.link.org" : "shell.link.people"), exact: true });
  try {
    await (await link("/people")).click();
    await expect(page).toHaveURL(/\/people$/);
    await expect(page.locator("main h1").first()).toBeVisible();
    await expect(trigger).toHaveAccessibleName(t("shell.needsMe.count", { count: 3 }));
    expect(reads).toBe(2);
  } finally { release(); }
  for (const path of ["/org", "/people"] as const) {
    await (await link(path)).click();
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    await expect(page.locator("main h1").first()).toBeVisible();
    await page.clock.runFor(1_000);
    expect(reads).toBe(2);
    expect(await badge!.evaluate(el => el.isConnected)).toBe(true);
    await expect(trigger).toHaveAccessibleName(t("shell.needsMe.count", { count: 3 }));
  }
  expect(chunks).toEqual([]);
  if (!headerPanel) {
    expect(mock.unexpected).toEqual([]);
    return;
  }
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
