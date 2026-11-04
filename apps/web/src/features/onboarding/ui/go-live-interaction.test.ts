// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from "node:assert/strict";
import AxeBuilder from "@axe-core/playwright";
import { resolve } from "node:path";
import { realpathSync } from "node:fs";
import { afterAll, beforeAll, describe, test } from "vitest";
import { chromium, expect as browserExpect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { browserTestOptimizeDeps } from "../../../lib/browser-test";

// Serve the real component and hooks in Chromium; only API responses and the passkey device are fixtures.
let server: ViteDevServer;
let browser: Browser;
beforeAll(async () => {
  server = await createServer({
    // The installed virtualizer uses this switch for browser measurements.
    define: { "process.env.VIRT_ON": "true" },
    configFile: false, appType: "custom", cacheDir: ".cache/vite-go-live-test",
    optimizeDeps: browserTestOptimizeDeps,
    resolve: { alias: {
      "@console/api": resolve("packages/api/src"),
      "@console/i18n": resolve("packages/i18n/src"),
    }, dedupe: ["react", "react-dom"] },
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, fs: { allow: [resolve("."), realpathSync("node_modules"), realpathSync("node_modules/pretendard")] } },
    plugins: [{
      name: "go-live-test",
      configureServer(s) {
        s.middlewares.use((req, res, next) => {
          if (req.url?.split("?")[0] !== "/setup/go-live") return next();
          res.setHeader("Content-Type", "text/html");
          res.end('<!doctype html><html lang="en"><head><title>Console</title></head><body><div id="root"></div><script type="module" src="/__go-live-test.tsx"></script></body></html>');
        });
      },
      resolveId: (id) => id === "/__go-live-test.tsx" ? id : undefined,
      load: (id) => id === "/__go-live-test.tsx" ? `
        import React from "react";
        import "/apps/web/src/app.css";
        import { createRoot } from "react-dom/client";
        import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
        import { createRootRoute, createRoute, createRouter, RouterProvider, Outlet, Link } from "@tanstack/react-router";
        import { configure } from "@console/api";
        import { i18n, loadCatalog } from "@console/i18n";
        import { GoLive } from "/apps/web/src/features/onboarding/ui/go-live.tsx";
        configure({ baseUrl: location.origin, refresh: { kind: "cookie" },
          passkeys: { get: async () => ({ id: "test-passkey" }), create: async () => null } });
        const locale = new URLSearchParams(location.search).get("locale") ?? "en";
        await loadCatalog(locale);
        i18n.set(locale);
        document.documentElement.lang = locale;
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        window.addEventListener("go-live-refetch", () => void client.refetchQueries());
        const root = createRootRoute({ component: Outlet });
        const router = createRouter({ routeTree: root.addChildren([
          createRoute({ getParentRoute: () => root, path: "/setup/go-live", component: GoLive }),
          createRoute({ getParentRoute: () => root, path: "/org", component: () => <Link to="/setup/go-live">Return to preview</Link> }),
          createRoute({ getParentRoute: () => root, path: "/", component: () => <h1>Operations</h1> }),
        ]) });
        createRoot(document.getElementById("root")).render(
          <QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>);
      ` : undefined,
    }],
  });
  await server.listen();
  browser = await chromium.launch();
}, 60_000);
afterAll(async () => { await browser?.close(); await server?.close(); });

describe("go-live submission", () => {
  let page: Page;
  const preview = {
    phase: "SETUP", digest: "blocked", line_digests: {} as Record<string, string>,
    blockers: [{ code: "no_department", count: 0, remedy: "add_department", records: [] }],
    warnings: [{ code: "sole_holder", count: 0, remedy: null, records: [] }], becomes_governed: [],
    breakdown: [], roles_becoming_active: [], access_admin_holders: [], hr_accounts_with_no_grant: [],
    facts: { entities: 1, workplaces: 1, org_units: 0, employees: 1, employees_starting_later: 0,
      setup_writes: 0, prepared_grants: 0, grants_effective_in_setup: 0, hr_accounts_invited: 0, hr_accounts_enrolled: 0 },
  };
  let pendingRead: Promise<void> | undefined;
  const launches: unknown[] = [];
  let ceremonies = 0;
  beforeAll(async () => {
    page = await browser.newPage();
    await page.route("**/api/v1/onboarding/go-live/preview", async (route) => {
      await pendingRead;
      await route.fulfill({ json: preview });
    });
    await page.route("**/api/v1/auth/passkey/login/start", async (route) => {
      ceremonies++;
      await route.fulfill({ json: { ceremony_id: "ceremony", challenge: { publicKey: {} } } });
    });
    await page.route("**/api/v1/onboarding/go-live", async (route) => {
      launches.push(route.request().postDataJSON());
      assert.ok(route.request().headers()["idempotency-key"]);
      await route.fulfill({ json: { phase: "OPERATING", go_live_at: "2026-10-20T12:00:00Z", notified: 1 } });
    });
    // Mount with the real blocked answer before timing the interaction, including cold Vite transforms.
    await page.goto(`${server.resolvedUrls!.local[0]}setup/go-live`);
    await browserExpect(page.getByRole("checkbox")).toBeVisible({ timeout: 30_000 });
  }, 60_000);

  test("clicks cannot launch while blocked or refreshing; the remedy returns to a ready preview that submits once", async () => {
    try {
      const start = page.getByRole("button", { name: "Start operations", exact: true });
      await page.getByRole("checkbox").check();
      await browserExpect(start).toHaveAttribute("aria-disabled", "true");
      await start.click({ force: true });
      await page.getByRole("link", { name: "Add a department", exact: true }).click();
      await browserExpect(page).toHaveURL(/\/org$/);
      assert.deepEqual(launches, []);
      assert.equal(ceremonies, 0);

      preview.facts.org_units = 1;
      preview.blockers = [];
      const returning = Promise.withResolvers<void>();
      pendingRead = returning.promise;
      await page.getByRole("link", { name: "Return to preview" }).click();
      await browserExpect(page.getByRole("status")).toBeVisible();
      await browserExpect(start).toHaveCount(0);
      returning.resolve();
      await page.getByRole("checkbox").check();
      await browserExpect(start).toBeEnabled();

      const refreshing = Promise.withResolvers<void>();
      pendingRead = refreshing.promise;
      await page.evaluate(() => window.dispatchEvent(new Event("go-live-refetch")));
      await browserExpect(start).toHaveAttribute("aria-disabled", "true");
      await start.click({ force: true });
      assert.deepEqual(launches, []);
      assert.equal(ceremonies, 0);
      preview.digest = "fresh-department-preview";
      preview.line_digests = { org_units: "fresh-department-line" };
      refreshing.resolve();
      await browserExpect(start).not.toHaveAttribute("aria-disabled", "true");
      await start.click();
      await browserExpect(page.getByRole("heading", { name: "Operations", exact: true })).toBeVisible();
      assert.equal(ceremonies, 1);
      assert.deepEqual(launches, [{
        digest: "fresh-department-preview", line_digests: { org_units: "fresh-department-line" },
        sole_holder_acknowledged: true, step_up: { ceremony_id: "ceremony", credential: { id: "test-passkey" } },
      }]);
    } finally {
      await page.close();
    }
  }, 5000);
});

describe.each([3, 2000])("department readiness with %i people", (count) => {
  let screenContext: BrowserContext;
  let screen: Page;
  const records = Array.from({ length: count }, (_, id) => ({ kind: "employee", id: String(id), name: `부서지정대상직원${String(id).padStart(4, "0")}`, legal_entity_id: "entity" }));
  // One page per count: each test sets its own viewport and theme and only reads the screen.
  beforeAll(async () => {
    screenContext = await browser.newContext();
    screen = await screenContext.newPage();
    await screen.route("**/api/v1/onboarding/go-live/preview", (route) => route.fulfill({ json: {
      phase: "SETUP", digest: "department-blocked", line_digests: {},
      blockers: [{ code: "people_without_department", count: records.length, remedy: "assign_department", records }],
      warnings: [], becomes_governed: [], breakdown: [], roles_becoming_active: [], access_admin_holders: [], hr_accounts_with_no_grant: [],
      facts: { entities: 1, workplaces: 1, org_units: 1, employees: records.length, employees_starting_later: 0,
        staffed_workplaces_without_registration: 0, empty_workplaces_without_registration: 0,
        setup_writes: 0, prepared_grants: 0, grants_effective_in_setup: 0, hr_accounts_invited: 0, hr_accounts_enrolled: 0 },
    } }));
    await screen.goto(`${server.resolvedUrls!.local[0]}setup/go-live?locale=ko`);
    await browserExpect(screen.getByRole("rowheader", { name: records[0]!.name, exact: true })).toBeVisible({ timeout: 30_000 });
  }, 60_000);
  afterAll(async () => { await screenContext?.close(); });

  test.each([
    [1440, "light"], [1440, "dark"], [390, "light"], [390, "dark"],
  ] as const)("virtualizes the records with one bulk fix at %i px in %s", async (width, theme) => {
    const blocker = screen.getByRole("alert", { name: `부서 없는 직원 ${count.toLocaleString("ko-KR")}명`, exact: true });
    await screen.setViewportSize({ width, height: 900 });
    await screen.locator("html").evaluate((el, value) => { el.dataset.theme = value; }, theme);
    await browserExpect(blocker).toBeVisible();
    const table = blocker.getByRole("grid");
    await browserExpect(table).toBeVisible();
    if (width === 390) {
      await browserExpect(table).toHaveAttribute("data-layout", "cards");
      await browserExpect(table.getByRole("columnheader", { name: "직원", exact: true })).toHaveCount(0);
    } else {
      await browserExpect(table).toHaveAttribute("data-layout", "rows");
      await browserExpect(table.getByRole("columnheader", { name: "직원", exact: true })).toBeVisible();
    }
    await browserExpect(table.getByText(records[0]!.name, { exact: true })).toBeVisible();
    const nameCell = table.getByRole("rowheader", { name: records[0]!.name, exact: true });
    await browserExpect.poll(() => nameCell.evaluate((el) => el.scrollWidth <= el.clientWidth), { message: `${width} ${theme}: the full employee name fits its cell` }).toBe(true);
    await browserExpect.poll(() => table.evaluate((el) => el.getBoundingClientRect().width / el.closest("[role=alert]")!.getBoundingClientRect().width), { message: `${width} ${theme}: the grid uses the panel body width` }).toBeGreaterThanOrEqual(0.5);
    await browserExpect(blocker.getByRole("group", { name: "해결 방법", exact: true }).getByRole("grid")).toHaveCount(0);
    await browserExpect(blocker.getByRole("link", { name: "부서 지정", exact: true })).toHaveCount(1);
    await browserExpect(blocker.getByRole("link", { name: "부서 지정", exact: true })).toHaveAttribute("href", "/people?review=department");
    await browserExpect(blocker.getByText("법인 · 사업장", { exact: true })).toHaveCount(0);
    await browserExpect(table).toHaveAttribute("aria-rowcount", String(count + 1));
    await browserExpect.poll(() => table.getByRole("row").count(), { message: "only a viewport of employees is rendered" }).toBeLessThan(50);
    await browserExpect(screen.getByRole("button", { name: "운영 시작", exact: true })).toHaveAttribute("aria-disabled", "true");
    await browserExpect.poll(() => screen.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    const { violations } = await new AxeBuilder({ page: screen }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    assert.deepEqual(violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => v.id), [], `${width} ${theme}`);
  });
});

describe("resolved blocker collapse and receipt layout", () => {
  let ctx: BrowserContext;
  let page: Page;
  beforeAll(async () => {
    ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    page = await ctx.newPage();
    let accepted = false;
    await page.route("**/api/v1/onboarding/go-live/preview", (route) =>
      route.fulfill({
        json: {
          phase: "SETUP",
          digest: accepted ? "ready-digest" : "terms-blocked-digest",
          line_digests: {},
          blockers: accepted ? [] : [{ code: "terms_not_accepted", count: null, remedy: "accept_terms", records: [] }],
          warnings: [],
          becomes_governed: ["setup_undo_becomes_correction"],
          breakdown: [{ kind: "legal_entity", id: "e1", legal_entity_id: "e1", name: "검증법인", people: 10, units: 2 }],
          roles_becoming_active: [],
          access_admin_holders: [{ id: "u1", name: "김담당" }],
          hr_accounts_with_no_grant: [],
          facts: {
            entities: 1, workplaces: 1, staffed_workplaces_without_registration: 0, empty_workplaces_without_registration: 0,
            org_units: 2, employees: 10, employees_starting_later: 0, setup_writes: 3,
            prepared_grants: 0, grants_effective_in_setup: 1, hr_accounts_invited: 1, hr_accounts_enrolled: 1,
          },
        },
      }),
    );
    await page.route("**/api/v1/onboarding/terms", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          json: {
            version: "2026-10-01",
            sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            body: Array.from({ length: 14 }, (_, i) => `제${i + 1}조 서비스 이용 약관 본문입니다.`).join("\n\n"),
          },
        });
      } else {
        accepted = true;
        await route.fulfill({ status: 204 });
      }
    });
    await page.goto(`${server.resolvedUrls!.local[0]}setup/go-live?locale=ko`);
  }, 60_000);
  afterAll(async () => { await ctx?.close(); });

  test("accepting service terms collapses the resolved row without blank space while keeping the governed heading stable", async () => {
    await page.getByRole("button", { name: "이용약관 읽기", exact: true }).click();
    const accept = page.getByRole("button", { name: "고객 계정을 대표해 이용약관 동의", exact: true });
    await browserExpect(accept).toBeVisible();
    const governed = page.getByRole("heading", { name: "운영을 시작하면 바뀌는 것", level: 2 });
    const beforeGoverned = (await governed.boundingBox())!.y;
    await accept.click();
    await browserExpect(accept).toBeHidden();
    const resolved = page.getByText("해결함", { exact: true });
    await browserExpect(resolved).toBeVisible();
    const resolvedRowHeight = await resolved.evaluate((el) => el.closest("[data-blocker-row]")?.getBoundingClientRect().height ?? 999);
    assert.ok(resolvedRowHeight < 80, `expected compact resolved row (<80px), got ${resolvedRowHeight}px`);
    const afterGoverned = (await governed.boundingBox())!.y;
    assert.ok(Math.abs(afterGoverned - beforeGoverned) < 2, `governed heading shifted by ${Math.abs(afterGoverned - beforeGoverned)}px`);
  });
});
