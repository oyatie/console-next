// SPDX-License-Identifier: LicenseRef-Proprietary
import { resolve } from "node:path";
import { createServer, type ViteDevServer } from "vite";
import { expect, test } from "@playwright/test";
import { go } from "./flows";

let server: ViteDevServer;
test.beforeAll(async () => {
  server = await createServer({
    configFile: false, appType: "custom", cacheDir: ".cache/vite-navigation-test",
    optimizeDeps: { include: ["react", "react/jsx-runtime", "react-dom/client", "@tanstack/react-query", "@tanstack/react-router", "openapi-fetch", "intl-messageformat"] },
    resolve: { alias: { "@console/api": resolve("packages/api/src"), "@console/i18n": resolve("packages/i18n/src") }, dedupe: ["react", "react-dom"] },
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false },
    plugins: [{
      name: "navigation-fixture",
      configureServer(s) {
        s.middlewares.use((req, res, next) => {
          if (req.url?.includes(".") || req.url?.startsWith("/@")) return next();
          res.setHeader("Content-Type", "text/html");
          res.end('<div id="root"></div><script type="module" src="/__navigation-ready.tsx"></script>');
        });
      },
      resolveId: id => id.startsWith("/__navigation-") ? id : undefined,
      load: id => id === "/__navigation-ready.tsx" ? `
        import { createRoot } from "react-dom/client";
        import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
        import { createRoute, createRouter, lazyRouteComponent, Navigate, Outlet, RouterProvider } from "@tanstack/react-router";
        import { root } from "/apps/web/src/routes/app.ts";
        const shell = createRoute({ getParentRoute: () => root, id: "shell", component: () => <main><Outlet /></main> });
        const start = createRoute({ getParentRoute: () => shell, path: "/", component: () => <h1>Start</h1> });
        const destination = createRoute({
          getParentRoute: () => shell, path: "/destination",
          validateSearch: s => ({ revision: String(s.revision ?? "") }),
          loader: () => fetch("/loader"),
          component: lazyRouteComponent(() => import("/__navigation-screen.tsx"), "Screen"),
        });
        const redirect = createRoute({ getParentRoute: () => shell, path: "/redirect", component: () => <Navigate to="/destination" search={{ revision: "redirect" }} /> });
        createRoot(document.getElementById("root")).render(
          <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
            <RouterProvider router={createRouter({ routeTree: root.addChildren([shell.addChildren([start, destination, redirect])]) })} />
          </QueryClientProvider>);
      ` : id === "/__navigation-screen.tsx" ? `
        import { useQuery } from "@tanstack/react-query";
        export function Screen() {
          const q = useQuery({ queryKey: ["navigation", location.search], queryFn: () => fetch("/read" + location.search).then(r => r.text()) });
          return <><h1>Destination</h1>{q.isPending ? <p role="status">Loading</p> : <button>{q.data}</button>}</>;
        }
      ` : undefined,
    }],
  });
  await server.listen();
});
test.afterAll(async () => { await server?.close(); });

test("go waits for the destination render, loader and initial read before absence assertions", async ({ page }) => {
  await page.goto(server.resolvedUrls!.local[0]!);
  await expect(page.getByRole("heading", { name: "Start" })).toBeVisible();
  const loader = Promise.withResolvers<void>();
  const read = Promise.withResolvers<void>();
  await page.route("**/loader", async route => { await loader.promise; await route.fulfill({ body: "loaded" }); });
  await page.route("**/read?*", async route => { await read.promise; await route.fulfill({ body: "Late action" }); });
  const started = page.waitForRequest("**/loader");
  let returned = false;
  const navigating = go(page, "/destination?revision=first").then(() => { returned = true; });
  await started;
  // Planted false green: URL is already correct and the previous main is still visible.
  await expect(page).toHaveURL(/destination\?revision=first$/);
  await expect(page.getByRole("button", { name: "Late action" })).toHaveCount(0);
  expect(returned, "go must still be waiting for the route loader").toBe(false);
  loader.resolve();
  await expect(page.getByRole("heading", { name: "Destination" })).toBeVisible();
  expect(returned, "a heading alone must not skip the destination read").toBe(false);
  read.resolve();
  await navigating;
  // With old go(), the same immediate absence assertion above wrongly passes after navigation.
  await expect(page.getByRole("button", { name: "Late action" })).toBeVisible();
  await expect(page.getByRole("status")).toHaveCount(0);

  // Same-path search navigation and redirects must identify the new committed route, not reuse its old marker.
  await go(page, "/destination?revision=second");
  await expect(page.getByRole("button", { name: "Late action" })).toBeVisible();
  await go(page, "/redirect", true);
  await expect(page).toHaveURL(/destination\?revision=redirect$/);
  await expect(page.getByRole("button", { name: "Late action" })).toBeVisible();
});

test("go also waits on a fresh page and repeated navigation to the same URL", async ({ page }) => {
  await go(page, server.resolvedUrls!.local[0]!);
  await expect(page.getByRole("heading", { name: "Start" })).toBeVisible();
  await go(page, "/");
  await expect(page.getByRole("heading", { name: "Start" })).toBeVisible();
});

test("a missing route signal cannot produce a green absence check", async ({ page }) => {
  await page.route("**/*", route => route.fulfill({ contentType: "text/html", body: "<main><h1>Unready</h1></main>" }));
  page.setDefaultTimeout(200);
  await expect(go(page, server.resolvedUrls!.local[0]!)).rejects.toThrow("page.waitForFunction: Timeout");
});

test("measure ready-route navigation without fixed waits", async ({ page }, testInfo) => {
  await go(page, server.resolvedUrls!.local[0]!);
  await expect(page.getByRole("heading", { name: "Start" })).toBeVisible();
  const iterations = 20;
  const start = performance.now();
  for (let i = 0; i < iterations; i++) await go(page, "/");
  const elapsed = performance.now() - start;
  console.log(`navigation-wall ${testInfo.project.name}: ${iterations} navigations in ${elapsed.toFixed(1)} ms`);
  await expect(page.getByRole("heading", { name: "Start" })).toBeVisible();
});
