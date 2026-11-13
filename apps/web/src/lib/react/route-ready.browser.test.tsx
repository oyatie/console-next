// SPDX-License-Identifier: LicenseRef-Proprietary
import { resolve as resolvePath } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { expect as dom, type Browser, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { browserEngine } from "../browser-test";

let server: ViteDevServer;
const engine = browserEngine();
let browser: Browser;
let page: Page;
beforeAll(async () => {
  server = await createServer({
    configFile: false, appType: "custom", cacheDir: ".cache/vite-route-ready-test",
    optimizeDeps: { include: ["react", "react/jsx-runtime", "react-dom/client", "@tanstack/react-query", "openapi-fetch", "intl-messageformat"] },
    resolve: { alias: { "@tanstack/react-router": "/__router.tsx", "@console/api": resolvePath("packages/api/src"), "@console/i18n": resolvePath("packages/i18n/src") }, dedupe: ["react", "react-dom"] },
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false },
    plugins: [{
      name: "route-ready-fixture",
      configureServer(s) {
        s.middlewares.use((req, res, next) => {
          if (req.url?.includes(".") || req.url?.startsWith("/@")) return next();
          res.setHeader("Content-Type", "text/html");
          res.end('<div id="root"></div><script type="module" src="/__ready.tsx"></script>');
        });
      },
      resolveId: id => ["/__ready.tsx", "/__router.tsx"].includes(id) ? id : undefined,
      load: id => id === "/__router.tsx" ? `
        import { useState } from "react";
        import { useQuery } from "@tanstack/react-query";
        import { read } from "/apps/web/src/lib/query.ts";
        const guard = new URLSearchParams(location.search).get("guard");
        const state = { location: { pathname: "/", href: location.pathname + location.search, state: { __TSR_key: "entry" } } };
        const router = { state, subscribe: () => () => {} };
        export const useRouter = () => router;
        export const notFound = () => {};
        export const redirect = () => {};
        export const useLocation = ({ select }) => select(state.location);
        export function useRouterState() {
          const [held, release] = useState(true);
          window.releaseRouter = () => release(false);
          // The real router couples these fields; independent snapshots pin both defensive guards.
          return { ...state, status: held && guard === "status" ? "pending" : "idle", isLoading: held && guard === "isLoading" };
        }
        export function Outlet() {
          const [started, start] = useState(false);
          window.startRead = () => start(true);
          const q = useQuery({ ...read("/read", () => fetch("/read").then(r => r.text())), enabled: started || guard === "reading" || guard === "paused" });
          return <main><h1>Content</h1><p>{q.data}</p></main>;
        }
      ` : id === "/__ready.tsx" ? `
        import { createRoot } from "react-dom/client";
        import { onlineManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
        import { RouteFrame } from "/apps/web/src/lib/react/route-ready.tsx";
        if (new URLSearchParams(location.search).get("guard") === "paused") onlineManager.setOnline(false);
        window.resumeRead = () => onlineManager.setOnline(true);
        createRoot(document.getElementById("root")).render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><RouteFrame /></QueryClientProvider>);
      ` : undefined,
    }],
  });
  await server.listen();
  browser = await engine.launch();
  page = await browser.newPage();
}, 60_000);
afterAll(async () => { await browser?.close(); await server?.close(); });

test.each(["status", "isLoading", "reading", "paused"])(`${engine.name()}: %s holds readiness beyond publication, then releases`, async guard => {
  const read = Promise.withResolvers<void>();
  await page.route("**/read", async route => { await read.promise; await route.fulfill({ body: "Read settled" }); });
  const requested = guard === "reading" ? page.waitForRequest("**/read") : undefined;
  try {
    await page.goto(`${server.resolvedUrls!.local[0]}?guard=${guard}`);
    await dom(page.getByRole("heading", { name: "Content" })).toBeVisible();
    await requested;
    // Sample beyond the two-frame publish, while only this guard can veto readiness.
    expect(await page.evaluate(async () => {
      const markers: number[] = [];
      for (let frame = 0; frame < 6; frame++) {
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        markers.push(document.querySelectorAll("[data-route-ready]").length);
      }
      return markers;
    })).toEqual([0, 0, 0, 0, 0, 0]);
    await page.evaluate(() => {
      const control = window as unknown as { releaseRouter: () => void; resumeRead: () => void };
      control.releaseRouter();
      control.resumeRead();
    });
    read.resolve();
    await dom(page.locator("[data-route-ready]")).toHaveAttribute("data-route-ready", `/?guard=${guard}`);
    if (guard === "reading" || guard === "paused") await dom(page.getByText("Read settled")).toBeVisible();
  } finally { read.resolve(); await page.unrouteAll({ behavior: "wait" }); }
});

test(`${engine.name()}: an obsolete deferred observer cannot publish during a new read`, async () => {
  const module = Promise.withResolvers<void>();
  const read = Promise.withResolvers<void>();
  const requested = Promise.withResolvers<void>();
  await page.route("**/apps/web/src/lib/react/session.ts*", async route => { requested.resolve(); await module.promise; await route.continue(); });
  await page.route("**/read", async route => { await read.promise; await route.fulfill({ body: "Read settled" }); });
  try {
    await page.goto(`${server.resolvedUrls!.local[0]}?guard=late-reading`, { waitUntil: "domcontentloaded" });
    await dom(page.getByRole("heading", { name: "Content" })).toBeVisible();
    await requested.promise;
    const fetching = page.waitForRequest("**/read");
    await page.evaluate(() => (window as unknown as { startRead: () => void }).startRead());
    await fetching;
    const loaded = page.waitForResponse("**/apps/web/src/lib/react/session.ts*");
    module.resolve();
    await loaded;
    await page.evaluate("import('/apps/web/src/lib/react/session.ts').then(() => {})");
    expect(await page.evaluate(async () => {
      const markers: number[] = [];
      for (let frame = 0; frame < 6; frame++) {
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        markers.push(document.querySelectorAll("[data-route-ready]").length);
      }
      return markers;
    })).toEqual([0, 0, 0, 0, 0, 0]);
    read.resolve();
    await dom(page.locator("[data-route-ready]")).toHaveAttribute("data-route-ready", "/?guard=late-reading");
    await dom(page.getByText("Read settled")).toBeVisible();
  } finally { module.resolve(); read.resolve(); await page.unrouteAll({ behavior: "wait" }); }
});
