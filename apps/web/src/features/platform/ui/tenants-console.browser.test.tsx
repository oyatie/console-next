// SPDX-License-Identifier: LicenseRef-Proprietary
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";
import { expect as element, type Locator, type Route } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { loadCatalog, t } from "@console/i18n";
import { browserEngine, browserTestOptimizeDeps, type Browser, type Page } from "../../../lib/browser-test";
import { AT, failure, id } from "../../../../../../e2e/mock/fixtures";
import { MAX_RETRY_AFTER_MS } from "../../../lib/react/query-defaults";
import type { EraseRead, OpsRecoveryRead, Org, OrgStatus } from "../api";

let server: ViteDevServer;
let browser: Browser;
let page: Page;
beforeAll(async () => {
  await loadCatalog("ko");
  server = await createServer({ configFile: false, cacheDir: ".cache/tenants-console-test", logLevel: "error",
    optimizeDeps: browserTestOptimizeDeps,
    resolve: { dedupe: ["react", "react-dom"], alias: [{ find: /^@console\/i18n$/, replacement: resolve("packages/i18n/src/index.ts") }] },
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, fs: { allow: [resolve("."), realpathSync("node_modules/pretendard")] } },
    plugins: [{ name: "tenants-console-test", resolveId: key => key === "/tenants-console-test.js" ? "\0tenants-console-test" : undefined,
      load: key => key === "\0tenants-console-test" ? `
        import {createElement as h} from 'react'; import {createRoot} from 'react-dom/client';
        import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
        import {createMemoryHistory,createRootRoute,createRoute,createRouter,RouterProvider} from '@tanstack/react-router';
        import {configure} from '@console/api'; import {loadCatalog} from '@console/i18n';
        import {TenantsPage} from '/apps/web/src/features/platform/ui/tenants-page.tsx';
        import '/apps/web/src/app.css';
        await loadCatalog('ko');
        document.documentElement.dataset.experience='console';
        document.documentElement.dataset.theme='light';
        configure({baseUrl:location.origin,refresh:{kind:'cookie'},passkeys:{get:async()=>null,create:async()=>null}});
        const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
        const root=createRootRoute(),app=createRoute({getParentRoute:()=>root,id:'app'});
        const route=createRoute({getParentRoute:()=>app,path:'/platform',component:TenantsPage});
        const router=createRouter({routeTree:root.addChildren([app.addChildren([route])]),history:createMemoryHistory({initialEntries:[location.hash.slice(1)||'/platform']})});
        createRoot(document.getElementById('root')).render(h(QueryClientProvider,{client},h(RouterProvider,{router})));
      ` : undefined }],
  });
  await server.listen();
  browser = await browserEngine().launch();
  page = await browser.newPage();
  await page.route("**/tenants-console-test", route => route.fulfill({ contentType: "text/html", body: '<html lang="ko"><title>Tenants</title><div id="root"></div><script type="module" src="/tenants-console-test.js"></script></html>' }));
}, 60_000);
afterAll(async () => { await browser?.close(); await server?.close(); });
afterEach(async () => {
  await page.evaluate(() => { Reflect.deleteProperty(navigator, "onLine"); dispatchEvent(new Event("online")); }).catch(() => undefined);
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await page.route("**/tenants-console-test", route => route.fulfill({ contentType: "text/html", body: '<html lang="ko"><title>Tenants</title><div id="root"></div><script type="module" src="/tenants-console-test.js"></script></html>' }));
});

const org = (status: OrgStatus, removable = true): Org => ({ id: id(5000), name: "Synthetic customer", slug: "customer", group_id: null, group_slug: null,
  group_name: null, status, removable, removal_refusal: removable ? null : "tenant_has_data", created_at: AT, updated_at: AT });
const RECOVERY: OpsRecoveryRead = { request: null, state: null, recovery_available: false, ops_has_passkey: false, ops_enrolled: false,
  second_operator_available: true, active_accounts: 0, hold_hours: 24, code_ttl_minutes: 10 };
const erased = (status: OrgStatus): EraseRead => ({ request: null, archived: status === "ARCHIVED", legal_hold: false, second_operator_available: true, cooling_hours: 24 });
// As the server answers when it is down: a Retry-After past the client's cap, which the failure's reason then names.
const unavailable = { status: 503, json: failure("upstream_failure"), headers: { "retry-after": String(Math.ceil(MAX_RETRY_AFTER_MS / 1000) + 1) } };

/** Answers `path` with what `answer` returns once `hold` resolves, so a test can see the page before and after it lands. */
async function held(path: string, answer: () => { status?: number; json: unknown; headers?: Record<string, string> }) {
  const gate = { hold: Promise.withResolvers<void>() };
  await page.route(path, async (route: Route) => {
    await gate.hold.promise;
    await route.fulfill(answer()).catch(() => undefined);
  });
  return gate;
}

async function platform(orgs: () => { status?: number; json: unknown; headers?: Record<string, string> }, path = "/platform") {
  await page.route("**/api/platform/ops", route => route.fulfill({ json: { tenants: [], notices: [] } }));
  await page.route("**/api/platform/groups", route => route.fulfill({ json: [] }));
  await page.route(url => url.pathname === "/api/platform/support-sessions", route => route.fulfill({ json: { sessions: [] } }));
  const list = await held("**/api/platform/orgs", orgs);
  // A fresh document per test: a hash-only change would keep the last test's app and its cache.
  await page.goto("about:blank");
  await page.goto(`${server.resolvedUrls!.local[0]}tenants-console-test#${path}`);
  await page.getByRole("heading", { level: 1 }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  return list;
}

const create = () => page.getByRole("main").getByRole("button", { name: t("tenants.create"), exact: true });
const box = (locator: Locator) => locator.evaluate(el => el.getBoundingClientRect().toJSON());
const offline = () => page.evaluate(() => { Object.defineProperty(navigator, "onLine", { configurable: true, get: () => false }); dispatchEvent(new Event("offline")); });

test("opening a customer account waits for the list, and a failed list says why it cannot open one", async () => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const list = await platform(() => unavailable);
  await element(create()).toBeDisabled();
  const before = await box(create());
  list.hold.resolve();
  const alert = page.getByRole("main").getByRole("alert");
  await element(alert.getByRole("heading", { name: t("common.loadFailed.title"), exact: true })).toBeVisible();
  await element(create()).toHaveAttribute("aria-disabled", "true");
  await element(create()).toHaveAccessibleDescription(t("tenants.create.unavailable"));
  await element(alert.getByText(t("tenants.create.unavailable"), { exact: true })).toBeVisible();
  expect(await box(create())).toEqual(before);
  await create().click({ force: true });
  await element(page.getByRole("dialog")).toHaveCount(0);
}, 60_000);

test("offline before the first answer, opening an account says why; back online with the list it opens", async () => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const list = await platform(() => ({ json: [org("ACTIVE")] }));
  await offline();
  await element(page.getByRole("main").getByRole("heading", { name: t("common.read.offline"), exact: true })).toBeVisible();
  await element(create()).toHaveAttribute("aria-disabled", "true");
  await element(create()).toHaveAccessibleDescription(t("tenants.create.unavailable"));
  await page.evaluate(() => { Reflect.deleteProperty(navigator, "onLine"); dispatchEvent(new Event("online")); });
  list.hold.resolve();
  await element(page.getByRole("gridcell", { name: "Synthetic customer", exact: true })).toBeVisible();
  await element(create()).toBeEnabled();
  await element(create()).not.toHaveAttribute("aria-disabled", "true");
}, 60_000);

test("a keyboard user on the unavailable open-account button keeps their place while the list reloads after reconnecting", async () => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const list = await platform(() => ({ json: [org("ACTIVE")] }));
  await offline();
  const offlineFailure = page.getByRole("main").getByRole("heading", { name: t("common.read.offline"), exact: true });
  await element(offlineFailure).toBeVisible();
  await create().focus();
  await page.evaluate(() => { Reflect.deleteProperty(navigator, "onLine"); dispatchEvent(new Event("online")); });
  // Back online, the list loads again: the button waits, and focus stays on it.
  await element(offlineFailure).toHaveCount(0);
  await element(create()).toBeDisabled();
  await element(create()).toBeFocused();
  list.hold.resolve();
  await element(page.getByRole("gridcell", { name: "Synthetic customer", exact: true })).toBeVisible();
  await element(create()).toBeEnabled();
  await element(create()).toBeFocused();
}, 60_000);

test("offline with the list and an open record, the offline notice shows once and opening an account stays available", async () => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route("**/api/platform/orgs/*/erase", route => route.fulfill({ json: erased("ACTIVE") }));
  await page.route("**/api/platform/orgs/*/ops-recovery", route => route.fulfill({ json: RECOVERY }));
  const list = await platform(() => ({ json: [org("ACTIVE")] }));
  list.hold.resolve();
  const panel = page.getByRole("complementary", { name: "Synthetic customer", exact: true });
  await element(panel.getByRole("button", { name: t("tenants.reissue"), exact: true })).toBeVisible();
  await element(panel.getByRole("button", { name: t("tenants.remove.force", { org: "Synthetic customer" }), exact: true })).toHaveAccessibleDescription(t("tenants.erase.tenant_active"));
  await offline();
  await element(page.getByRole("main").getByText(t("common.read.offline"), { exact: true })).toHaveCount(1);
  await element(panel.getByRole("button", { name: t("tenants.reissue"), exact: true })).toBeVisible();
  await element(create()).toBeEnabled();
  await element(create()).toHaveAccessibleDescription("");
}, 60_000);

/** The record's sections by heading, in order, and where deletion starts below the overview (scrolling cannot change it). */
const pane = (panel: Locator) => panel.evaluate((aside, { overview, remove }) => {
  // Record sections only: the regions inside them are sections too.
  const sections = [...aside.querySelectorAll("section:has(> header > h3)")].filter(section => section.checkVisibility({ visibilityProperty: true }));
  const titled = (title: string) => sections.find(section => section.querySelector("h3")?.textContent === title)!;
  const deletion = titled(remove);
  const above = deletion.previousElementSibling!;
  return {
    titles: sections.map(section => section.querySelector("h3")?.textContent),
    deletion: deletion.getBoundingClientRect().top - titled(overview).getBoundingClientRect().top,
    rule: getComputedStyle(above).borderBlockEndWidth,
  };
}, { overview: t("tenants.panel.overview"), remove: t("tenants.section.remove") });

/** The blank room between the recovery section's last content and deletion. */
const deadSpace = (panel: Locator) => panel.evaluate((aside, { recoveryTitle, removeTitle }) => {
  const titled = (title: string) => [...aside.querySelectorAll("section:has(> header > h3)")].find(section => section.querySelector("h3")?.textContent === title)!;
  const content = [...titled(recoveryTitle).querySelectorAll("button, p, span")].map(el => el.getBoundingClientRect().bottom);
  return titled(removeTitle).getBoundingClientRect().top - Math.max(...content);
}, { recoveryTitle: t("opsRecovery.title"), removeTitle: t("tenants.section.remove") });

test.each((["ACTIVE", "SUSPENDED", "ARCHIVED"] as const).flatMap(status => [1440, 390].map(width => ({ status, width }))))(
  "$status record at $width px keeps deletion still while its recovery read loads, fails and retries",
  async ({ status, width }) => {
    await page.setViewportSize({ width, height: 1600 });
    await page.route("**/api/platform/orgs/*/erase", route => route.fulfill({ json: erased(status) }));
    let fails = true;
    let recovery = await held("**/api/platform/orgs/*/ops-recovery", () => fails ? unavailable : { json: RECOVERY });
    const list = await platform(() => ({ json: [org(status)] }), "/platform?view=all");
    list.hold.resolve();
    await page.getByRole("gridcell", { name: "Synthetic customer", exact: true }).click();
    const panel = page.getByRole("complementary", { name: "Synthetic customer", exact: true });
    const deletion = panel.getByRole("button", { name: t("tenants.remove", { org: "Synthetic customer" }), exact: true });
    await element(deletion).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    const loading = await pane(panel);
    expect(loading.titles.at(-1)).toBe(t("tenants.section.remove"));
    // The copy that holds the room stays out of sight.
    expect(loading.titles).not.toContain(t("opsRecovery.title"));
    expect(loading.rule).toBe("1px");
    recovery.hold.resolve();
    const failed = panel.getByRole("alert").filter({ has: page.getByRole("heading", { name: t("tenants.recoveryFailed"), exact: true }) });
    await element(failed).toHaveCount(1);
    await element(panel.getByRole("button", { name: t("common.retry"), exact: true })).toHaveCount(1);
    // The failure is inset like the record's sections.
    expect((await box(failed)).left).toBe((await box(panel.getByRole("heading", { name: t("tenants.panel.overview"), exact: true }))).left);
    expect((await pane(panel)).deletion).toBe(loading.deletion);
    fails = false;
    await page.unroute("**/api/platform/orgs/*/ops-recovery");
    recovery = await held("**/api/platform/orgs/*/ops-recovery", () => ({ json: RECOVERY }));
    await failed.getByRole("button", { name: t("common.retry"), exact: true }).click();
    expect((await pane(panel)).deletion).toBe(loading.deletion);
    recovery.hold.resolve();
    await element(panel.getByRole("button", { name: t("opsRecovery.open"), exact: true })).toBeVisible();
    await element(failed).toHaveCount(0);
    const settled = await pane(panel);
    expect(settled.deletion).toBe(loading.deletion);
    expect(settled.titles.slice(-3)).toEqual(status === "ACTIVE"
      ? [t("tenants.section.code"), t("opsRecovery.title"), t("tenants.section.remove")]
      : [t("tenants.panel.overview"), t("opsRecovery.title"), t("tenants.section.remove")]);
    expect(settled.rule).toBe("1px");
    // The reserved room stays close to what a settled read draws.
    expect(await deadSpace(panel)).toBeLessThan(80);
  }, 60_000);

// An established tenant: its first admin has a passkey, so its answer is shorter than the held room.
const ENROLLED: OpsRecoveryRead = { ...RECOVERY, ops_enrolled: true, ops_has_passkey: true, recovery_available: true };

test.each([1440, 390])("an established tenant's shorter recovery answer leaves deletion where the held read had it at %i px", async width => {
  await page.setViewportSize({ width, height: 1600 });
  await page.route("**/api/platform/orgs/*/erase", route => route.fulfill({ json: erased("ACTIVE") }));
  const recovery = await held("**/api/platform/orgs/*/ops-recovery", () => ({ json: ENROLLED }));
  const list = await platform(() => ({ json: [org("ACTIVE")] }));
  list.hold.resolve();
  await page.getByRole("gridcell", { name: "Synthetic customer", exact: true }).click();
  const panel = page.getByRole("complementary", { name: "Synthetic customer", exact: true });
  await element(panel.getByRole("button", { name: t("tenants.remove", { org: "Synthetic customer" }), exact: true })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  const loading = await pane(panel);
  recovery.hold.resolve();
  await element(panel.getByRole("button", { name: t("opsRecovery.open"), exact: true })).toBeEnabled();
  await element(panel.getByRole("button", { name: t("tenants.reissue"), exact: true })).toHaveAccessibleDescription(t("tenants.reissue.enrolled", { org: "Synthetic customer" }));
  expect((await pane(panel)).deletion).toBe(loading.deletion);
}, 60_000);

test.each([1440, 390])("suspending an open tenant lets go of the room its active answer was held in at %i px", async width => {
  await page.setViewportSize({ width, height: 1600 });
  let status: OrgStatus = "ACTIVE";
  await page.route("**/api/platform/orgs/*/erase", route => route.fulfill({ json: erased(status) }));
  const recovery = await held("**/api/platform/orgs/*/ops-recovery", () => ({ json: RECOVERY }));
  const list = await platform(() => ({ json: [org(status)] }), "/platform?view=all");
  list.hold.resolve();
  await page.getByRole("gridcell", { name: "Synthetic customer", exact: true }).click();
  const panel = page.getByRole("complementary", { name: "Synthetic customer", exact: true });
  await element(panel.getByRole("button", { name: t("tenants.remove", { org: "Synthetic customer" }), exact: true })).toBeVisible();
  recovery.hold.resolve();
  await element(panel.getByRole("button", { name: t("tenants.reissue"), exact: true })).toBeVisible();
  status = "SUSPENDED";
  // The move reaches the open record when the list is read again, as after this pane's own status dialog.
  await page.evaluate(() => dispatchEvent(new Event("visibilitychange")));
  await element(panel.getByRole("button", { name: t("tenants.reissue"), exact: true })).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);
  expect(await deadSpace(panel)).toBeLessThan(80);
}, 60_000);

test("a recovery read refused after it answered replaces the code and recovery controls, and deletion stays put", async () => {
  await page.setViewportSize({ width: 1440, height: 1600 });
  await page.route("**/api/platform/orgs/*/erase", route => route.fulfill({ json: erased("ACTIVE") }));
  let refused = false;
  await page.route("**/api/platform/orgs/*/ops-recovery", route => route.fulfill(refused ? { status: 403, json: failure("forbidden") } : { json: RECOVERY }));
  const list = await platform(() => ({ json: [org("ACTIVE")] }));
  list.hold.resolve();
  const panel = page.getByRole("complementary", { name: "Synthetic customer", exact: true });
  await element(panel.getByRole("button", { name: t("tenants.reissue"), exact: true })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  const settled = await pane(panel);
  refused = true;
  // The page coming back into view refetches its reads, as a person returning to the tab would.
  await page.evaluate(() => dispatchEvent(new Event("visibilitychange")));
  await element(panel.getByRole("heading", { name: t("common.denied.panel"), exact: true })).toBeVisible();
  await element(panel.getByRole("button", { name: t("tenants.reissue"), exact: true })).toHaveCount(0);
  await element(panel.getByRole("button", { name: t("opsRecovery.open"), exact: true })).toHaveCount(0);
  expect((await pane(panel)).deletion).toBe(settled.deletion);
}, 60_000);

test("a failed refresh after the recovery read answered keeps the code and recovery controls, and its notice leaves no gap", async () => {
  await page.setViewportSize({ width: 1440, height: 1600 });
  await page.route("**/api/platform/orgs/*/erase", route => route.fulfill({ json: erased("ACTIVE") }));
  let down = false;
  await page.route("**/api/platform/orgs/*/ops-recovery", route => route.fulfill(down ? unavailable : { json: RECOVERY }));
  const list = await platform(() => ({ json: [org("ACTIVE")] }));
  list.hold.resolve();
  const panel = page.getByRole("complementary", { name: "Synthetic customer", exact: true });
  await element(panel.getByRole("button", { name: t("tenants.reissue"), exact: true })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  const settled = await pane(panel);
  down = true;
  await page.evaluate(() => dispatchEvent(new Event("visibilitychange")));
  const retry = panel.getByRole("button", { name: t("common.retry"), exact: true });
  await element(retry).toHaveCount(1);
  await element(panel.getByRole("button", { name: t("tenants.reissue"), exact: true })).toBeVisible();
  await element(panel.getByRole("button", { name: t("opsRecovery.open"), exact: true })).toBeVisible();
  // Once a refresh answers again, the notice goes and the sections close up: the held room is not kept after an answer.
  down = false;
  await retry.click();
  await element(retry).toHaveCount(0);
  expect((await pane(panel)).deletion).toBe(settled.deletion);
}, 60_000);

test.each([{ first: "recovery", removable: true }, { first: "erase", removable: false }] as const)(
  "record buttons stay still when the $first read lands first (removable $removable)",
  async ({ first, removable }) => {
    await page.setViewportSize({ width: 1440, height: 1600 });
    const reads = {
      recovery: await held("**/api/platform/orgs/*/ops-recovery", () => ({ json: RECOVERY })),
      erase: await held("**/api/platform/orgs/*/erase", () => ({ json: erased("ACTIVE") })),
    };
    const list = await platform(() => ({ json: [org("ACTIVE", removable)] }));
    list.hold.resolve();
    const panel = page.getByRole("complementary", { name: "Synthetic customer", exact: true });
    await element(panel.getByRole("button", { name: t("tenants.remove.force", { org: "Synthetic customer" }), exact: true })).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    const buttons = () => panel.getByRole("button").evaluateAll(elements => Object.fromEntries(elements.map(el => [el.textContent, el.getBoundingClientRect().top])));
    const before = await buttons();
    for (const read of [first, first === "recovery" ? "erase" : "recovery"] as const) {
      const landed = page.waitForResponse(response => response.url().endsWith(read === "erase" ? "/erase" : "/ops-recovery"));
      reads[read].hold.resolve();
      await (await landed).finished();
      await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
      const after = await buttons();
      for (const [name, top] of Object.entries(before)) expect(after[name], `${name} after ${read}`).toBe(top);
    }
    await element(panel.getByRole("button", { name: t("tenants.reissue"), exact: true })).toBeVisible();
  }, 60_000);
