// SPDX-License-Identifier: LicenseRef-Proprietary
import { resolve } from "node:path";
import { realpathSync } from "node:fs";
import { chromium, expect as expectDom, type Browser, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, expect, test } from "vitest";
import { browserTestOptimizeDeps, openBrowserTestPage } from "../../lib/browser-test";

let server: ViteDevServer;
let browser: Browser;
let page: Page;

beforeAll(async () => {
  server = await createServer({
    configFile: false,
    cacheDir: ".cache/month-grid-test",
    logLevel: "error",
    optimizeDeps: browserTestOptimizeDeps,
    resolve: { dedupe: ["react", "react-dom"] },
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, fs: { allow: [resolve("."), realpathSync("node_modules/pretendard")] } },
    plugins: [{
      name: "month-grid-test",
      resolveId: (id) => (id === "/month-grid-test.js" ? "\0month-grid-test" : undefined),
      load: (id) => (id === "\0month-grid-test" ? `
        import { createElement as h, useState } from 'react';
        import { createRoot } from 'react-dom/client';
        import { MonthGrid } from '/apps/web/src/ui/month-grid/month-grid.tsx';
        import '/apps/web/src/app.css';

        const FULL_WEEKS = [0, 1, 2, 3, 4].map((w) =>
          Array.from({ length: 7 }, (_, d) => new Date(Date.UTC(2026, 8, 27 + w * 7 + d)).toISOString().slice(0, 10))
        );
        const RAGGED_WEEKS = [
          ['2026-09-27', '2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03'],
          ['2026-10-04', '2026-10-05', '2026-10-06'],
        ];

        window.lastDefaultPrevented = null;
        function App() {
          const params = new URLSearchParams(location.search);
          const readonly = params.get('readonly') === 'true';
          const ragged = params.get('ragged') === 'true';
          const [selected, setSelected] = useState('2026-10-01');
          const [lastEvent, setLastEvent] = useState('');
          return h('main', {
            onKeyDown: (e) => { window.lastDefaultPrevented = e.defaultPrevented; },
          },
            h('h1', null, 'Month Grid'),
            h('output', { id: 'selected' }, selected),
            h('output', { id: 'events' }, lastEvent),
            h(MonthGrid, {
              label: 'October 2026',
              weeks: ragged ? RAGGED_WEEKS : FULL_WEEKS,
              weekdays: ['S', 'M', 'T', 'W', 'T', 'F', 'S'],
              inMonth: (d) => d.startsWith('2026-10'),
              cell: () => null,
              selected,
              onSelect: readonly ? undefined : (d) => { setSelected(d); setLastEvent(d); },
            })
          );
        }

        createRoot(document.getElementById('root')).render(h(App));
      ` : undefined),
      configureServer: (vite) => {
        vite.middlewares.use((req, res, next) => {
          if (req.url?.split("?")[0] !== "/month-grid-test") return next();
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.end('<!doctype html><html lang="en"><head><title>MonthGrid</title></head><body><div id="root"></div><script type="module" src="/month-grid-test.js"></script></body></html>');
        });
      },
    }],
  });
  await server.listen();
  browser = await chromium.launch();
  page = await browser.newPage();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

const url = (query = "") => `${server.resolvedUrls!.local[0]}month-grid-test${query}`;
const cell = (date: string) => page.locator(`td[data-date="${date}"]`);
const activeDate = () => page.evaluate(() => document.activeElement?.getAttribute("data-date"));
const lastPrevented = () => page.evaluate(() => (window as unknown as { lastDefaultPrevented: boolean | null }).lastDefaultPrevented);

test("ArrowUp on row 0 and ArrowDown on the final row preserve column instead of wrapping horizontally", async () => {
  await openBrowserTestPage(page, url(), cell("2026-10-01"));

  await cell("2026-09-30").focus();
  await page.keyboard.press("ArrowUp");
  expect(await activeDate()).toBe("2026-09-30");
  expect(await lastPrevented()).toBe(true);

  await cell("2026-09-27").focus();
  await page.keyboard.press("ArrowUp");
  expect(await activeDate()).toBe("2026-09-27");
  expect(await lastPrevented()).toBe(true);

  await cell("2026-10-28").focus();
  await page.keyboard.press("ArrowDown");
  expect(await activeDate()).toBe("2026-10-28");
  expect(await lastPrevented()).toBe(true);

  await cell("2026-10-31").focus();
  await page.keyboard.press("ArrowDown");
  expect(await activeDate()).toBe("2026-10-31");
  expect(await lastPrevented()).toBe(true);
});

test("interior ArrowUp/ArrowDown move +/-7 days and ArrowLeft/ArrowRight wrap weeks and stop at bounds", async () => {
  await openBrowserTestPage(page, url(), cell("2026-10-01"));

  await cell("2026-10-08").focus();
  await page.keyboard.press("ArrowDown");
  expect(await activeDate()).toBe("2026-10-15");
  await page.keyboard.press("ArrowUp");
  expect(await activeDate()).toBe("2026-10-08");

  await cell("2026-10-03").focus();
  await page.keyboard.press("ArrowRight");
  expect(await activeDate()).toBe("2026-10-04");
  await page.keyboard.press("ArrowLeft");
  expect(await activeDate()).toBe("2026-10-03");

  await cell("2026-09-27").focus();
  await page.keyboard.press("ArrowLeft");
  expect(await activeDate()).toBe("2026-09-27");

  await cell("2026-10-31").focus();
  await page.keyboard.press("ArrowRight");
  expect(await activeDate()).toBe("2026-10-31");
});

test("Home and End move to week ends and End clamps on a ragged final row", async () => {
  await openBrowserTestPage(page, url(), cell("2026-10-01"));
  await cell("2026-10-14").focus();
  await page.keyboard.press("Home");
  expect(await activeDate()).toBe("2026-10-11");
  await page.keyboard.press("End");
  expect(await activeDate()).toBe("2026-10-17");

  await openBrowserTestPage(page, url("?ragged=true"), cell("2026-10-01"));
  await cell("2026-10-04").focus();
  await page.keyboard.press("End");
  expect(await activeDate()).toBe("2026-10-06");
  expect(await lastPrevented()).toBe(true);
});

test("Enter and Space invoke onSelect only when provided and skip preventDefault when read-only", async () => {
  await openBrowserTestPage(page, url(), cell("2026-10-01"));
  await cell("2026-10-15").focus();
  await page.keyboard.press("Enter");
  await expectDom(page.locator("#selected")).toHaveText("2026-10-15");
  expect(await lastPrevented()).toBe(true);

  await cell("2026-10-16").focus();
  await page.keyboard.press("Space");
  await expectDom(page.locator("#selected")).toHaveText("2026-10-16");
  expect(await lastPrevented()).toBe(true);

  await openBrowserTestPage(page, url("?readonly=true"), cell("2026-10-01"));
  await cell("2026-10-15").focus();
  await page.keyboard.press("Space");
  await expectDom(page.locator("#events")).toHaveText("");
  expect(await lastPrevented()).toBe(false);
});
