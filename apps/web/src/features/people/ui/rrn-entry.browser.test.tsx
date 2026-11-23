// SPDX-License-Identifier: LicenseRef-Proprietary
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import { browserTestOptimizeDeps, chromium, type Browser, type Page } from "../../../lib/browser-test";
import { rrn } from "../../../../../../e2e/helpers/import-layouts";

let server: ViteDevServer;
let browser: Browser;
let page: Page;
const secret = rrn("1990-01-01", 1, 9);

beforeAll(async () => {
  server = await createServer({
    configFile: false,
    cacheDir: ".cache/rrn-entry-test",
    logLevel: "error",
    optimizeDeps: browserTestOptimizeDeps,
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, fs: { allow: [resolve("."), realpathSync("node_modules/pretendard")] } },
    plugins: [{
      name: "rrn-entry-test",
      resolveId: (id) => (id === "/rrn-entry-test.js" ? "\0rrn-entry-test" : undefined),
      load: (id) =>
        id === "\0rrn-entry-test"
          ? `
        import {createElement} from 'react'; import {createRoot} from 'react-dom/client';
        import {QueryClient,QueryClientProvider} from '@tanstack/react-query'; import {configure} from '@console/api';
        import {createMemoryHistory,createRootRoute,createRouter,RouterContextProvider} from '@tanstack/react-router';
        import {loadCatalog} from '@console/i18n';
        import {RrnEntry} from '/apps/web/src/features/people/ui/rrn-entry.tsx';
        import '/apps/web/src/app.css';
        configure({baseUrl:location.origin,refresh:{kind:'cookie'},passkeys:{get:async()=>({id:"proof"}),create:async()=>null}});
        await loadCatalog('ko');
        const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
        const router=createRouter({routeTree:createRootRoute(),history:createMemoryHistory({initialEntries:['/']})});
        createRoot(document.getElementById('root')).render(createElement(QueryClientProvider,{client},
          createElement(RouterContextProvider,{router},createElement(RrnEntry,{employeeId:'person',who:'Test',allowed:true}))));
      `
          : undefined,
      configureServer: (vite) => {
        vite.middlewares.use((req, res, next) => {
          if (req.url?.split("?")[0] !== "/rrn-entry-test") return next();
          res.setHeader("Content-Type", "text/html");
          res.end('<!doctype html><html lang="ko"><head><title>Entry</title></head><body><div id="root"></div><script type="module" src="/rrn-entry-test.js"></script></body></html>');
        });
      },
    }],
  });
  await server.listen();
  browser = await chromium.launch();
  page = await (await browser.newContext()).newPage();
}, 60_000);
afterAll(async () => {
  await browser?.close();
  await server?.close();
});
beforeEach(async () => {
  await page.route("**/api/v1/auth/passkey/step-up/start", (route) => route.fulfill({ json: { ceremony_id: "ceremony", challenge: { publicKey: {} } } }));
});
afterEach(async () => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("record supports optional DOMESTIC_RESIDENCE id_type and surfaces id_type_rrn_mismatch", async () => {
  let sent: Record<string, unknown> | undefined;
  let attempts = 0;
  await page.route("**/api/v1/employees/person/rrn", (route) => {
    attempts += 1;
    sent = route.request().postDataJSON();
    if (attempts === 1) {
      return route.fulfill({ status: 422, json: { error: { code: "id_type_rrn_mismatch", message: "mismatch" } } });
    }
    return route.fulfill({ status: 201, json: { employee_id: "person", recorded: true, masked: "••••••-•••••••", source: "FORM" } });
  });
  await page.goto(`${server.resolvedUrls!.local[0]}rrn-entry-test`);
  await page.getByRole("button").first().click();
  const sheet = page.getByRole("dialog");
  await sheet.locator("input").first().fill(secret);
  const idSelect = sheet.getByRole("combobox");
  await idSelect.selectOption("DOMESTIC_RESIDENCE");
  const submitBtn = sheet.getByRole("button").last();
  await submitBtn.click();
  await expect.poll(() => attempts).toBe(1);
  expect(sent?.id_type).toBe("DOMESTIC_RESIDENCE");
  await sheet.getByRole("alert").waitFor();

  const f4 = rrn("1995-05-05", 6, 12);
  await sheet.locator("input").first().fill(f4);
  await idSelect.selectOption("DOMESTIC_RESIDENCE");
  await submitBtn.click();
  await sheet.waitFor({ state: "detached" });
  expect(sent?.id_type).toBe("DOMESTIC_RESIDENCE");
});
