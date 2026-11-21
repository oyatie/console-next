// SPDX-License-Identifier: LicenseRef-Proprietary
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { expect as expectElement, type Browser, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, expect, test } from "vitest";
import { browserEngine } from "../lib/browser-test";

let server: ViteDevServer;
let browser: Browser;
let page: Page;

beforeAll(async () => {
  server = await createServer({
    configFile: false,
    cacheDir: ".cache/table-grouped-test",
    logLevel: "error",
    optimizeDeps: { include: ["react", "react/jsx-dev-runtime", "react-dom/client"] },
    resolve: { dedupe: ["react", "react-dom"] },
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, fs: { allow: [resolve("."), realpathSync("node_modules/pretendard")] } },
    plugins: [
      {
        name: "table-grouped-test",
        resolveId: id => (id === "/table-grouped.js" ? "\0table-grouped" : undefined),
        load: id =>
          id === "\0table-grouped"
            ? `
          import { createElement as h, useState } from 'react';
          import { createRoot } from 'react-dom/client';
          import { Check } from '/apps/web/src/ui/button/button.tsx';
          import { GroupedTable } from '/apps/web/src/ui/table-grouped.tsx';
          import '/apps/web/src/app.css';
          function App() {
            const [selected, setSelected] = useState('r1');
            const [checked, setChecked] = useState(false);
            return h('main', null, h(GroupedTable, {
              label: 'Grouped auto',
              rows: [
                { id: 'r1', name: 'Row 1', amount: '1,000', flag: 'Held' },
                { id: 'r2', name: 'Row 2', amount: '2,000', flag: 'OK' },
              ],
              rowId: r => r.id,
              selected,
              onSelect: setSelected,
              density: 'compact',
              mobileLayout: 'compact',
              scrollLayout: 'auto',
              columnGroups: [{ key: 'id', span: 2 }, { key: 'pay', label: 'Pay', span: 2 }],
              columns: [
                { header: 'Pick', fit: true, card: 'omit', cell: r => h(Check, { checked: r.id === 'r2' ? checked : false, onChange: () => r.id === 'r2' && setChecked(v => !v), 'aria-label': 'Pick ' + r.id }) },
                { header: 'Name', card: 'fact', cell: r => r.name },
                { header: 'Amount', type: 'money', emphasis: 'strong', card: 'action', cell: r => r.amount },
                { header: 'Flag', fit: true, card: 'status', cellTone: r => (r.flag === 'Held' ? 'danger' : undefined), cell: r => r.flag },
              ],
              footerRow: {
                cells: [
                  { key: 'lbl', span: 2, content: 'Subtotal', card: 'label' },
                  { key: 'amt', type: 'money', content: '3,000', card: 'value' },
                  { key: 'cnt', content: '2 of 2', card: 'meta' },
                ],
              },
            }));
          }
          createRoot(document.getElementById('root')).render(h(App));
        `
            : undefined,
        configureServer: vite => {
          vite.middlewares.use((req, res, next) => {
            if (req.url?.split("?")[0] !== "/table-grouped") return next();
            res.setHeader("Content-Type", "text/html");
            res.end('<html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Table</title><div id="root"></div><script type="module" src="/table-grouped.js"></script></html>');
          });
        },
      },
    ],
  });
  await server.listen();
  browser = await browserEngine().launch();
  page = await browser.newPage();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

test("grouped auto-scroll tables render colgroup headers, cellTone, checkbox isolation, and responsive compact tfoot", async () => {
  await page.setViewportSize({ width: 1440, height: 844 });
  await page.goto(`${server.resolvedUrls!.local[0]}table-grouped`);
  const table = page.getByRole("grid", { name: "Grouped auto", exact: true });
  await expectElement(table).toHaveCSS("table-layout", "auto");
  await expectElement(table.locator('th[scope="colgroup"]')).toHaveText("Pay");
  await expectElement(table.locator('td[data-cell-tone="danger"]')).toHaveText("Held");
  await expectElement(table.locator("tfoot tr")).toContainText("Subtotal");

  await page.getByRole("checkbox", { name: "Pick r2", exact: true }).click();
  await expectElement(table.locator('tr[data-id="r1"]')).toHaveAttribute("aria-selected", "true");

  await page.setViewportSize({ width: 390, height: 844 });
  await expectElement(table.locator("tfoot")).toHaveCSS("display", "block");
  expect(await page.evaluate(() => document.scrollingElement!.scrollWidth)).toBeLessThanOrEqual(390);
});
