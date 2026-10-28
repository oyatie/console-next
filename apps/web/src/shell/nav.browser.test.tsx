// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ViteDevServer } from "vite";
import { afterAll, beforeAll, expect, test } from "vitest";
import { expect as element, type Browser, type Page } from "@playwright/test";
import { user } from "../../../../e2e/mock/fixtures";
import { clearShifts } from "../../../../e2e/stability";
import { navFixture } from "./nav.browser-fixture";

let server: ViteDevServer;
let browser: Browser;
let page: Page;
let errors: string[];
beforeAll(async () => { ({ server, browser, page, errors } = await navFixture()); }, 60_000);
afterAll(async () => { await browser?.close(); await server?.close(); });

test("a pending tenant phase never flashes the operating rail", async () => {
  let release!: () => void;
  const pending = new Promise<void>(done => { release = done; });
  await page.route("**/api/v1/users/me", async route => {
    await pending;
    await route.fulfill({ json: { ...user, tenant: { ...user.tenant, phase: "SETUP", go_live_at: null } } });
  });
  await page.route("**/api/v1/onboarding/checklist", route => route.fulfill({ status: 403, json: { error: { code: "forbidden" } } }));
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    const requested = page.waitForRequest("**/api/v1/users/me");
    const decisions = Promise.all(["access/me", "support-sessions/active"].map(path => page.waitForResponse(`**/api/v1/${path}`)));
    await page.goto(server.resolvedUrls!.local[0]!);
    await requested;
    await decisions;
    const rail = page.getByRole("navigation", { name: "주 메뉴" });
    // Let both access observers render while the phase response is still held.
    await page.evaluate(() => new Promise(done => setTimeout(done, 100)));
    await element(rail.getByRole("link")).toHaveText(["홈"]);
    release();
    await element(rail.getByRole("link")).toHaveText(["홈", "조직 구조", "직원", "권한"]);
  } finally {
    release();
    await page.unroute("**/api/v1/users/me");
    await page.unroute("**/api/v1/onboarding/checklist");
  }
});

test("a failed idle checklist refetch keeps the last good setup rail without a shift", async () => {
  let reads = 0;
  let unavailable = false;
  await page.route("**/api/v1/users/me", route => route.fulfill({ json: { ...user, tenant: { ...user.tenant, phase: "SETUP", go_live_at: null } } }));
  await page.route("**/api/v1/onboarding/checklist", route => { reads++; return !unavailable ? route.fulfill({ json: { phase: "SETUP", go_live_at: null, steps: [
    { state: "todo", action: "create_legal_entity" }, { state: "blocked", action: "register_employee" }, { state: "todo", action: "add_role" },
  ] } }) : route.fulfill({ status: 503, json: { error: { code: "unavailable" } } }); });
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(server.resolvedUrls!.local[0]!);
    const rail = page.getByRole("navigation", { name: "주 메뉴" });
    const entries = ["홈", "조직 구조", "권한"];
    await element(rail.getByRole("link")).toHaveText(entries);
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
    await page.evaluate(clearShifts);
    const before = reads;
    unavailable = true;
    const refetched = page.waitForResponse(response => response.url().endsWith("/api/v1/onboarding/checklist") && response.status() === 503);
    await page.evaluate(() => window.__refetchChecklist());
    await refetched;
    // Allow Query's observer notification and the layout-shift recorder to flush.
    await page.evaluate(() => new Promise(done => setTimeout(done, 600)));
    expect(reads).toBe(before + 1);
    expect(new URL(page.url()).pathname).toBe("/");
    await element(rail.getByRole("link")).toHaveText(entries);
    expect(await page.evaluate(() => window.__shifts)).toEqual([]);
  } finally {
    await page.unroute("**/api/v1/users/me");
    await page.unroute("**/api/v1/onboarding/checklist");
  }
});

test.each(["success", "conflict"])("a setup mutation's %s controls when the rail reveals the unblocked entry", async outcome => {
  let unblocked = false, refreshes = 0;
  let release!: () => void;
  const pending = new Promise<void>(done => { release = done; });
  await page.route("**/api/v1/users/me", route => route.fulfill({ json: { ...user, tenant: { ...user.tenant, phase: "SETUP", go_live_at: null } } }));
  await page.route("**/api/v1/onboarding/checklist", async route => {
    if (unblocked && outcome === "success") { refreshes++; await pending; }
    return route.fulfill({ json: { phase: "SETUP", steps: [
    { state: "todo", action: "create_legal_entity" }, { state: unblocked ? "todo" : "blocked", action: "register_employee" }, { state: "todo", action: "add_role" },
  ] } }); });
  await page.route("**/api/v1/onboarding/steps/org/skip", route => {
    unblocked = true;
    return outcome === "success" ? route.fulfill({ json: {} }) : route.fulfill({ status: 409, json: { error: { code: "stale_revision" } } });
  });
  try {
    await page.goto(server.resolvedUrls!.local[0]!);
    const rail = page.getByRole("navigation", { name: "주 메뉴" });
    await element(rail.getByRole("link")).toHaveText(["홈", "조직 구조", "권한"]);
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(clearShifts);
    const refreshed = page.waitForResponse("**/api/v1/onboarding/checklist");
    await page.getByRole("button", { name: "Complete setup" }).click();
    if (outcome === "success") {
      await element.poll(() => refreshes).toBe(1);
      const navigated = page.waitForResponse("**/api/v1/users/me");
      await page.evaluate(() => history.pushState({ ...history.state, __TSR_key: "command-refresh" }, "", "/org"));
      await navigated;
      await page.waitForTimeout(100);
      expect(refreshes).toBe(1);
    }
    release();
    await refreshed;
    await page.evaluate(() => new Promise(done => setTimeout(done, 600)));
    await element(rail.getByRole("link")).toHaveText(["홈", "조직 구조", "권한"]);
    expect(await page.evaluate(() => window.__shifts)).toEqual([]);
    if (outcome === "success") {
      await rail.getByRole("link", { name: "홈", exact: true }).click();
      await element(rail.getByRole("link", { name: "직원", exact: true })).toBeVisible();
    }
  } finally {
    release();
    await page.unroute("**/api/v1/users/me");
    await page.unroute("**/api/v1/onboarding/checklist");
    await page.unroute("**/api/v1/onboarding/steps/org/skip");
  }
});

test("a setup save with a 1.5 s checklist read reveals its entry only on the next navigation", async () => {
  let unblocked = false;
  await page.route("**/api/v1/users/me", route => route.fulfill({ json: { ...user, tenant: { ...user.tenant, phase: "SETUP", go_live_at: null } } }));
  await page.route("**/api/v1/onboarding/checklist", async route => {
    if (unblocked) await new Promise(done => setTimeout(done, 1500));
    await route.fulfill({ json: { phase: "SETUP", steps: [
      { state: "todo", action: "create_legal_entity" }, { state: unblocked ? "todo" : "blocked", action: "register_employee" }, { state: "todo", action: "add_role" },
    ] } });
  });
  await page.route("**/api/v1/onboarding/steps/org/skip", route => { unblocked = true; return route.fulfill({ json: {} }); });
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${server.resolvedUrls!.local[0]}org`);
    const rail = page.getByRole("navigation", { name: "주 메뉴" });
    const entries = ["홈", "조직 구조", "권한"];
    await element(rail.getByRole("link")).toHaveText(entries);
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(clearShifts);
    const saved = page.waitForResponse("**/api/v1/onboarding/steps/org/skip");
    const refreshed = page.waitForResponse("**/api/v1/onboarding/checklist");
    await page.getByRole("button", { name: "Complete setup" }).click();
    await saved;
    await rail.getByRole("link", { name: "홈", exact: true }).click();
    await element(page).toHaveURL(server.resolvedUrls!.local[0]!);
    await element(rail.getByRole("link")).toHaveText(entries);
    await refreshed;
    await page.waitForTimeout(600);
    expect(await page.evaluate(() => window.__shifts)).toEqual([]);
    await element(rail.getByRole("link")).toHaveText(entries);
    await rail.getByRole("link", { name: "조직 구조", exact: true }).click();
    await element(rail.getByRole("link")).toHaveText(["홈", "조직 구조", "직원", "권한"]);
  } finally {
    await page.unroute("**/api/v1/users/me");
    await page.unroute("**/api/v1/onboarding/checklist");
    await page.unroute("**/api/v1/onboarding/steps/org/skip");
  }
});

test("a changed idle checklist cannot change the rail until navigation", async () => {
  let unblocked = false;
  await page.route("**/api/v1/users/me", route => route.fulfill({ json: { ...user, tenant: { ...user.tenant, phase: "SETUP", go_live_at: null } } }));
  await page.route("**/api/v1/onboarding/checklist", route => route.fulfill({ json: { phase: "SETUP", steps: [
    { state: "todo", action: "create_legal_entity" }, { state: unblocked ? "todo" : "blocked", action: "register_employee" }, { state: "todo", action: "add_role" },
  ] } }));
  try {
    await page.goto(server.resolvedUrls!.local[0]!);
    const rail = page.getByRole("navigation", { name: "주 메뉴" });
    const entries = ["홈", "조직 구조", "권한"];
    await element(rail.getByRole("link")).toHaveText(entries);
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(clearShifts);
    unblocked = true;
    await page.evaluate(() => window.__refetchChecklist());
    await page.evaluate(() => new Promise(done => setTimeout(done, 600)));
    await element(rail.getByRole("link")).toHaveText(entries);
    expect(await page.evaluate(() => window.__shifts)).toEqual([]);
    await rail.getByRole("link", { name: "조직 구조", exact: true }).click();
    await element(rail.getByRole("link", { name: "직원", exact: true })).toBeVisible();
  } finally {
    await page.unroute("**/api/v1/users/me");
    await page.unroute("**/api/v1/onboarding/checklist");
  }
});

test("a pending SETUP checklist never flashes the fallback rail", async () => {
  let release!: () => void;
  const pending = new Promise<void>(done => { release = done; });
  await page.route("**/api/v1/users/me", route => route.fulfill({ json: { ...user, tenant: { ...user.tenant, phase: "SETUP", go_live_at: null } } }));
  await page.route("**/api/v1/onboarding/checklist", async route => {
    await pending;
    await route.fulfill({ status: 403, json: { error: { code: "forbidden", message: "권한이 없습니다" } } });
  });
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    const requested = page.waitForRequest("**/api/v1/onboarding/checklist");
    const decisions = Promise.all(["access/me", "support-sessions/active"].map(path => page.waitForResponse(`**/api/v1/${path}`)));
    await page.goto(server.resolvedUrls!.local[0]!);
    await requested;
    await decisions;
    await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
    const rail = page.getByRole("navigation", { name: "주 메뉴" });
    await element(rail.getByRole("link")).toHaveText(["홈"]);
    release();
    await element(rail.getByRole("link")).toHaveText(["홈", "조직 구조", "직원", "권한"]);
  } finally {
    release();
    await page.unroute("**/api/v1/users/me");
    await page.unroute("**/api/v1/onboarding/checklist");
  }
});

test.each([1440, 390])("the shared shell keeps flat module links and one current page at %spx", async width => {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`${server.resolvedUrls!.local[0]}people/exits`);
  const rail = page.getByRole("navigation", { name: "주 메뉴" });
  if (width === 390) await page.getByRole("button", { name: "메뉴", exact: true }).click();
  await element(rail.getByRole("link", { name: "직원", exact: true })).toHaveAttribute("aria-current", "page");
  await element(rail.locator('[aria-current="page"]')).toHaveCount(1);
  await element(rail.locator("ul ul")).toHaveCount(0);
  await rail.getByRole("link", { name: "조직 구조", exact: true }).click();
  if (width === 390) await page.getByRole("button", { name: "메뉴", exact: true }).click();
  await element(rail.getByRole("link", { name: "조직 구조", exact: true })).toHaveAttribute("aria-current", "page");
  await element(rail.locator('[aria-current="page"]')).toHaveCount(1);
  await element(rail.getByRole("link", { name: "법인·사업장", exact: true })).toHaveCount(0);
  if (width === 390) {
    await page.keyboard.press("Escape");
    await element(rail).toBeHidden();
    await element(page.getByRole("button", { name: "메뉴", exact: true })).toBeFocused();
  }
  expect(errors).toEqual([]);
}, 30_000);

test("unattended navigation keeps the rail stable and an unexpected shift is still counted", async () => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${server.resolvedUrls!.local[0]}people/exits`);
  const rail = page.getByRole("navigation", { name: "주 메뉴" });
  await element(rail.getByRole("link", { name: "직원", exact: true })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => new Promise(done => setTimeout(done, 600)));
  await page.evaluate(clearShifts);
  const entries = await rail.getByRole("link").allTextContents();
  await page.evaluate(() => history.pushState({ ...history.state, __TSR_key: "flat-proof" }, "", "/org/entities"));
  await element(rail.getByRole("link", { name: "조직 구조", exact: true })).toHaveAttribute("aria-current", "page");
  await element(rail.getByRole("link")).toHaveText(entries);
  await page.evaluate(() => new Promise(done => setTimeout(done, 600)));
  expect(await page.evaluate(() => window.__shifts)).toEqual([]);
  await page.evaluate(() => { document.querySelector<HTMLElement>('#rail a[href="/org"]')!.style.marginTop = "40px"; });
  await element.poll(() => page.evaluate(() => window.__shifts?.some(s => s.control))).toBe(true);
});

test.each([1440, 390])("period locks reached from settings keeps settings current at %spx", async width => {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`${server.resolvedUrls!.local[0]}settings`);
  const rail = page.getByRole("navigation", { name: "주 메뉴" });
  await page.getByRole("main").getByRole("link", { name: "Period locks", exact: true }).click();
  if (width === 390) await page.getByRole("button", { name: "메뉴", exact: true }).click();
  const settings = rail.getByRole("link", { name: "설정", exact: true });
  await element(settings).toHaveAttribute("aria-current", "page");
  await element(settings).toHaveAttribute("data-status", "active");
  await element(rail.locator('[aria-current="page"]')).toHaveCount(1);
  await element(rail.locator('[data-status="active"]')).toHaveCount(1);
});
