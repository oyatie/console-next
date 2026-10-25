// SPDX-License-Identifier: LicenseRef-Proprietary
import { browserTestOptimizeDeps } from "../../../lib/browser-test";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type Browser, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, expect, test } from "vitest";

let server: ViteDevServer;
let browser: Browser;
let page: Page;
beforeAll(async () => {
  server = await createServer({
    configFile: false, cacheDir: ".cache/unplaced-test", logLevel: "error",
    define: { "process.env.VIRT_ON": "true" },
    optimizeDeps: browserTestOptimizeDeps,
    resolve: { dedupe: ["react", "react-dom"] },
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, fs: { allow: [resolve("."), realpathSync("node_modules/pretendard")] } },
    plugins: [{
      name: "unplaced-test",
      resolveId: (id) => id === "/unplaced-test.js" ? "\0unplaced-test" : undefined,
      load: (id) => id === "\0unplaced-test" ? `
        import {createElement as h} from 'react'; import {createRoot} from 'react-dom/client';
        import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
        import {createMemoryHistory,createRootRoute,createRouter,RouterContextProvider} from '@tanstack/react-router';
        import {configure} from '@console/api'; import {loadCatalog} from '@console/i18n';
        import {UnplacedPage} from '/apps/web/src/features/people/ui/unplaced-page.tsx';
        import '/apps/web/src/app.css';
        await loadCatalog('ko');
        configure({baseUrl:location.origin,refresh:{kind:'cookie'},passkeys:{get:async()=>null,create:async()=>null}});
        const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
        const router=createRouter({routeTree:createRootRoute(),history:createMemoryHistory({initialEntries:['/people/unplaced']})});
        createRoot(document.getElementById('root')).render(h(QueryClientProvider,{client},
          h(RouterContextProvider,{router},h(UnplacedPage))));
      ` : undefined,
      configureServer: (vite) => { vite.middlewares.use((req, res, next) => {
        if (req.url !== "/unplaced-test") return next();
        res.setHeader("Content-Type", "text/html");
        res.end('<html lang="ko"><title>Unplaced</title><div id="root"></div><script type="module" src="/unplaced-test.js"></script></html>');
      }); },
    }],
  });
  await server.listen();
  browser = await chromium.launch();
  page = await browser.newPage();
}, 60_000);
afterAll(async () => { await browser?.close(); await server?.close(); });

test.each([1440, 390].flatMap(width => ["SETUP", "OPERATING"].map(phase => ({ width, phase }))))(
  "an empty company-mapping response keeps the queue controls fixed at $width px in $phase",
  async ({ width, phase }) => {
    await page.setViewportSize({ width, height: 900 });
    let release!: () => void;
    const pending = new Promise<void>(done => { release = done; });
    await page.route("**/api/v1/**", async route => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith("/unmapped-companies")) await pending;
      const data = path.endsWith("/unplaced") ? { count: 1, items: [{ employee_id: "person", name: "김직원", company: "한빛", legal_entity_id: "entity", workplace_id: "workplace", reason: "unit_unknown", source_org_unit: "인사팀" }] }
        : path.endsWith("/legal-entities") ? { items: [{ id: "entity", name: "한빛" }] }
        : path.endsWith("/org-structure") ? { entities: [] }
        : path.endsWith("/checklist") ? { phase }
        : { items: [] };
      await route.fulfill({ json: data });
    });
    try {
      await page.goto(`${server.resolvedUrls!.local[0]}unplaced-test`);
      const tabs = page.getByRole("group", { name: "법인", exact: true });
      const pick = page.getByRole("button", { name: /「인사팀」/ });
      await pick.waitFor();
      const loading = page.getByRole("status", { name: "불러오는 중…", exact: true });
      expect(await loading.count()).toBe(1);
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      const before = await Promise.all([tabs, pick].map(control => control.boundingBox()));
      release();
      await loading.waitFor({ state: "detached" });
      const after = await Promise.all([tabs, pick].map(control => control.boundingBox()));
      expect(after).toEqual(before);
    } finally {
      release();
      await page.unrouteAll({ behavior: "wait" });
    }
  },
);
