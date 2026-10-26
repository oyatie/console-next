// SPDX-License-Identifier: LicenseRef-Proprietary
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, expect as expectElement, type Browser, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, expect, test } from "vitest";

let server: ViteDevServer;
let browser: Browser;
let page: Page;

beforeAll(async () => {
  server = await createServer({
    configFile: false, cacheDir: ".cache/table-test", logLevel: "error",
    optimizeDeps: { include: ["react", "react/jsx-dev-runtime", "react-dom/client"] },
    resolve: { dedupe: ["react", "react-dom"] },
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, fs: { allow: [resolve("."), realpathSync("node_modules/pretendard")] } },
    plugins: [{
      name: "table-test",
      resolveId: id => id === "/table-test.js" ? "\0table-test" : undefined,
      load: id => id === "\0table-test" ? `
        import { createElement as h, useState } from 'react';
        import { createRoot } from 'react-dom/client';
        import { Table } from '/apps/web/src/ui/table.tsx';
        import '/apps/web/src/app.css';
        function App() {
          const [rows, setRows] = useState([{ id: 'first', name: 'Short', count: '0' }]);
          const [grouped, setGrouped] = useState(false);
          const [selected, setSelected] = useState();
          window.groupRows = () => { window.updateRows(); setGrouped(true); };
          window.updateRows = () => setRows([
            { id: 'first', name: 'Short', count: 'Code issued 12 · Passkey registered 345' },
            { id: 'live', name: 'A much longer tenant name arriving over the stream', count: '123456789' },
          ]);
          return h(Table, { label: 'Tenants', rows, rowId: r => r.id,
            groups: grouped ? [...rows].reverse().map(r => ({ id: r.id, header: r.name, rows: [r] })) : undefined,
            selected, onSelect: grouped ? setSelected : undefined,
            tone: grouped ? () => 'warn' : undefined, detail: grouped ? r => r.id === 'first' ? 'Row details' : null : undefined,
            columns: [
            { header: 'Name', cell: r => r.name },
            { header: 'Accounts', width: 'summary', fit: true, cell: r => r.count },
          ] });
        }
        createRoot(document.getElementById('root')).render(h(App));
      ` : undefined,
      configureServer: vite => {
        vite.middlewares.use((req, res, next) => {
          if (req.url !== "/table-test") return next();
          res.setHeader("Content-Type", "text/html");
          res.end('<html lang="en"><title>Table</title><div id="root"></div><script type="module" src="/table-test.js"></script></html>');
        });
      },
    }],
  });
  await server.listen();
  browser = await chromium.launch();
  page = await browser.newPage();
}, 60_000);

afterAll(async () => { await browser?.close(); await server?.close(); });

for (const width of [1440, 390]) {
  test(`column definitions preserve geometry when live rows and account counts arrive at ${width}px`, async () => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${server.resolvedUrls!.local[0]}table-test`);
    const cells = page.locator("tbody tr").first().locator("td");
    await expectElement(cells).toHaveCount(2);
    const geometry = () => cells.evaluateAll(els => els.map(el => {
      const rect = el.getBoundingClientRect();
      return { x: rect.x, width: rect.width };
    }));
    const before = await geometry();
    await page.evaluate(() => (window as unknown as { updateRows: () => void }).updateRows());
    await expectElement(page.locator("tbody tr")).toHaveCount(2);
    expect(await geometry()).toEqual(before);
    expect(await page.locator("table").evaluate(el => getComputedStyle(el).tableLayout)).toBe("fixed");
    expect(await cells.last().evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  });
}

test("grouped tables preserve row detail, tone and keyboard selection across native bodies", async () => {
  await page.goto(`${server.resolvedUrls!.local[0]}table-test`);
  await page.evaluate(() => (window as unknown as { groupRows: () => void }).groupRows());
  await expectElement(page.locator("tbody")).toHaveCount(2);
  await expectElement(page.locator('th[scope="rowgroup"]')).toHaveCount(2);
  await expectElement(page.getByText("Row details")).toBeVisible();
  const first = page.locator('tr[data-id="first"]'), last = page.locator('tr[data-id="live"]');
  await expectElement(first).toHaveAttribute("data-tone", "warn");
  await first.focus();
  await page.keyboard.press("ArrowUp");
  await expectElement(last).toBeFocused();
  await page.keyboard.press("Enter");
  await expectElement(last).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowDown");
  await expectElement(first).toBeFocused();
});
