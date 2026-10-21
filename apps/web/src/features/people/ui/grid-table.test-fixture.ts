// SPDX-License-Identifier: LicenseRef-Proprietary
import { afterAll, afterEach, beforeAll, beforeEach, expect } from "vitest";
import { chromium, type Browser, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadCatalog } from "@console/i18n";
import type { GridRow } from "./grid-table";
import type { GridField } from "../domain/grid";

let server: ViteDevServer;
let browser: Browser;
let page: Page;
let errors: string[];

function setupGridFixture(rows2000: readonly GridRow[], columns: readonly GridField[]) {
  beforeAll(async () => {
    await loadCatalog("en");
    // Mount the real component and GridPage styles; no backend or server-rendered event simulation.
    const entry = `
      import { useState } from 'react';
      import { createRoot } from 'react-dom/client';
      import { i18n, loadCatalog } from '@console/i18n';
      import { GridTable } from '/apps/web/src/features/people/ui/grid-table';
      import { GridPage } from '/apps/web/src/features/people/ui/grid-page';
      import { bulkSelection } from '/apps/web/src/features/people/ui/use-bulk-selection';
      import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
      import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from '@tanstack/react-router';
      import { configure } from '@console/api';
      import { webPlatform } from '@console/api/web';
      import s from '/apps/web/src/features/people/ui/grid-page.module.css';
      import '/apps/web/src/app.css';
      await loadCatalog('en');
      i18n.set('en');
      function Fixture() {
        const [rows, setRows] = useState(${JSON.stringify(rows2000)});
        const [activeCell, setActiveCell] = useState(null);
        const [activeChanges, setActiveChanges] = useState(0);
        const bounded = new URLSearchParams(location.search).has('bounded');
        return <div className={s.page} style={bounded ? undefined : {height: 'auto'}}>
          <header style={{height: 240, flexShrink: 0}}><button onClick={() => setRows([])}>Filter empty</button></header>
          <div id="scroller" className={s.gridWrap} style={bounded ? undefined : {flex: 'none'}}>
            <GridTable rows={rows} columns={${JSON.stringify(columns)}} label="People grid"
              activeCell={activeCell} onActiveChange={at => {setActiveCell(at); setActiveChanges(n => n + 1);}}
              onCell={(id, col, text) => setRows(rows => rows.map(row => row.id === id ? {...row, typed: row.typed.map((value, i) => i === col ? text : value)} : row))}
              statusOf={() => ({tone: 'same', text: 'Same'})}
              fieldLabel={f => f.key} suggestionOf={() => undefined} />
          </div><button id="after" data-active={JSON.stringify(activeCell)} data-active-changes={activeChanges}>After grid</button>
        </div>;
      }
      const isPage = new URLSearchParams(location.search).has('page');
      const router = createRouter({routeTree: createRootRoute(), history: createMemoryHistory({initialEntries: ['/']})});
      bulkSelection.set(new Map(${JSON.stringify(rows2000.map((row) => [row.id, row.name]))}));
      configure(webPlatform);
      createRoot(document.getElementById('root')).render(isPage
        ? <QueryClientProvider client={new QueryClient()}><RouterContextProvider router={router}><GridPage /></RouterContextProvider></QueryClientProvider>
        : <Fixture />);
    `;
    server = await createServer({
      configFile: false, root: process.cwd(), cacheDir: ".cache/grid-table-test-vite",
      plugins: [react(), {
        name: "grid-table-test-fixture",
        enforce: "pre",
        resolveId: (id, importer) => id === "/__grid-test.tsx" ? id
          : id === "./use-grid-data" && importer?.endsWith("/grid-page.tsx") ? "/__grid-data.ts" : undefined,
        load: (id) => id === "/__grid-test.tsx" ? entry : id === "/__grid-data.ts" ? `
          const people = ${JSON.stringify(rows2000.map((row) => ({ id: row.id, employee_number: row.number, name: row.name, job: "Developer", updated_at: "2026-10-20T00:00:00Z" })))};
          export const useGridData = () => ({people, value: (i, key) => key === 'sex' ? 'MALE' : people[i][key], ready: true, updatedAt: i => people[i].updated_at});
        ` : undefined,
        configureServer(vite) {
          vite.middlewares.use((req, res, next) => {
            if (req.url?.split("?")[0] !== "/__grid-test") return next();
            void vite.transformIndexHtml("/__grid-test", '<!doctype html><html><body><div id="root"></div><script type="module" src="/__grid-test.tsx"></script></body></html>')
              .then((html) => { res.setHeader("Content-Type", "text/html"); res.end(html); }).catch(next);
          });
        },
      }],
      server: { host: "127.0.0.1", port: 0, fs: { allow: [process.cwd(), dirname(realpathSync(resolve("node_modules/pretendard")))] } },
    });
    await server.listen();
    browser = await chromium.launch({ headless: true });
    // Load the virtual entry's dependencies before timing individual interactions.
    const warmup = await browser.newPage();
    try {
      await warmup.goto(`${server.resolvedUrls!.local[0]}__grid-test`);
      await warmup.getByRole("grid").waitFor();
    } finally {
      await warmup.close();
    }
  }, 30_000);

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });
  beforeEach(async () => {
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
  });
  afterEach(async () => {
    await page?.close();
    expect(errors).toEqual([]);
  });
}

async function mount(bounded = false) {
  await page.goto(`${server.resolvedUrls!.local[0]}__grid-test${bounded ? "?bounded" : ""}`);
  await page.getByRole("grid").waitFor();
}

async function expectWindowAt(row: number) {
  await expect.poll(() => page.getByRole("rowheader").allTextContents()).toContain(String(row));
  expect(await page.getByRole("rowheader").count()).toBeLessThanOrEqual(25 + 10);
  // Check geometry, not just DOM presence: the rendered rows must cover the viewport.
  const coverage = await page.evaluate(() => {
    const wrapper = document.getElementById("scroller")!;
    const bounds = wrapper.getBoundingClientRect();
    const top = Math.max(0, bounds.top + wrapper.clientTop);
    const bottom = Math.min(innerHeight, bounds.top + wrapper.clientTop + wrapper.clientHeight);
    const cells = [...document.querySelectorAll('[role="rowheader"]')];
    const first = cells[0]!.getBoundingClientRect();
    const last = cells.at(-1)!.getBoundingClientRect();
    return { coversTop: first.top <= top, coversBottom: last.bottom >= bottom, visible: cells.some((cell) => {
      const rect = cell.getBoundingClientRect();
      return rect.bottom > top && rect.top < bottom;
    }) };
  });
  expect(coverage).toEqual({ coversTop: true, coversBottom: true, visible: true });
}

export { page, server, setupGridFixture, mount, expectWindowAt };
