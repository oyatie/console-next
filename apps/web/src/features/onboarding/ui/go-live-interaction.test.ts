// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { afterAll, beforeAll, test } from "vitest";
import { chromium, expect as browserExpect, type Browser, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";

// Serve the real component and hooks in Chromium; only API responses and the passkey device are fixtures.
let server: ViteDevServer;
let browser: Browser;
let page: Page;
beforeAll(async () => {
  server = await createServer({
    // The installed virtualizer uses this switch for browser measurements.
    define: { "process.env.VIRT_ON": "true" },
    configFile: false, appType: "custom", cacheDir: ".cache/vite-go-live-test",
    resolve: { alias: {
      "@console/api": resolve("packages/api/src"),
      "@console/i18n": resolve("packages/i18n/src"),
    }, dedupe: ["react", "react-dom"] },
    server: { host: "127.0.0.1", port: 0 },
    plugins: [{
      name: "go-live-test",
      configureServer(s) {
        s.middlewares.use((req, res, next) => {
          if (req.url !== "/setup/go-live") return next();
          res.setHeader("Content-Type", "text/html");
          res.end('<div id="root"></div><script type="module" src="/__go-live-test.tsx"></script>');
        });
      },
      resolveId: (id) => id === "/__go-live-test.tsx" ? id : undefined,
      load: (id) => id === "/__go-live-test.tsx" ? `
        import React from "react";
        import { createRoot } from "react-dom/client";
        import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
        import { createRootRoute, createRoute, createRouter, RouterProvider, Outlet, Link } from "@tanstack/react-router";
        import { configure } from "@console/api";
        import { i18n, loadCatalog } from "@console/i18n";
        import { GoLive } from "/apps/web/src/features/onboarding/ui/go-live.tsx";
        configure({ baseUrl: location.origin, refresh: { kind: "cookie" },
          passkeys: { get: async () => ({ id: "test-passkey" }), create: async () => null } });
        await loadCatalog("en");
        i18n.set("en");
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
  // First load pays Vite's transforms and dep optimisation; do it here so the test's 5 s budget measures only the interaction.
  page = await browser.newPage();
  await page.goto(`${server.resolvedUrls!.local[0]}setup/go-live`, { waitUntil: "networkidle" });
}, 60_000);
afterAll(async () => { await browser?.close(); await server?.close(); });

test("clicks cannot launch while blocked or refreshing; the remedy returns to a ready preview that submits once", async () => {
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
  try {
    await page.goto(`${server.resolvedUrls!.local[0]}setup/go-live`);
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
