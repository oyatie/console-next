// SPDX-License-Identifier: LicenseRef-Proprietary
import { resolve } from "node:path";
import { realpathSync } from "node:fs";
import { AxeBuilder } from "@axe-core/playwright";
import { chromium, type Browser, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, expect, test } from "vitest";

let server: ViteDevServer;
let browser: Browser;
let page: Page;

beforeAll(async () => {
  server = await createServer({
    resolve: { dedupe: ["react", "react-dom"] },
    configFile: false, cacheDir: ".cache/server-picker-test", logLevel: "error",
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, fs: { allow: [resolve("."), realpathSync("node_modules/pretendard")] } },
    plugins: [{
      name: "server-picker-test",
      resolveId: (id) => id === "/picker-test.js" ? "\0picker-test" : undefined,
      load: (id) => id === "\0picker-test" ? `
        import { createElement as h, useState } from 'react';
        import { createRoot } from 'react-dom/client';
        import { loadCatalog } from '@console/i18n';
        import { ServerPicker } from '/apps/web/src/ui/server-picker/server-picker.tsx';
        import '/apps/web/src/app.css';
        await loadCatalog('en');
        function Picker() {
          const [query, setQuery] = useState('');
          const [value, setValue] = useState(null);
          const [clicks, setClicks] = useState(0);
          return h('main', null,
            h('div', { inert: true }, h('button', { id: 'already-inert' }, 'Unavailable')),
            h('button', { id: 'outside', onClick: () => setClicks(n => n + 1) }, 'Outside'),
            h(ServerPicker, { label: 'Person', group: 'People', empty: 'No people', query,
              onQueryChange: setQuery, value, onChange: setValue,
              options: [{ id: 'a', name: 'Namesake', display: 'Namesake · HR' }, { id: 'b', name: 'Namesake', display: 'Namesake · Sales' }, { id: 'c', name: 'Coded', code: 'E-3', display: 'Coded · E-3' }] }),
            h('input', { id: 'after', 'aria-label': 'After' }),
            h('output', { id: 'selected' }, value), h('output', { id: 'clicks' }, clicks));
        }
        createRoot(document.getElementById('root')).render(h(Picker));
      ` : undefined,
      configureServer: (vite) => {
        vite.middlewares.use((req, res, next) => {
          if (req.url !== "/picker-test") return next();
          res.setHeader("Content-Type", "text/html");
          res.end('<html lang="en"><title>Picker</title><div id="root"></div><script type="module" src="/picker-test.js"></script></html>');
        });
      },
    }],
  });
  await server.listen();
  browser = await chromium.launch();
  page = await (await browser.newContext()).newPage();
  page.setDefaultTimeout(15000);
}, 30000);

afterAll(async () => { await browser?.close(); await server?.close(); });

test("an open picker passes axe in both themes and preserves existing inert restrictions on close", async () => {
  await page.goto(`${server.resolvedUrls!.local[0]}picker-test`);
  const input = page.getByRole("combobox", { name: "Person" });
  await input.fill("Namesake");
  await page.getByRole("option").first().waitFor();
  for (const theme of ["light", "dark"]) {
    await page.locator("html").evaluate((el, value) => { el.dataset.theme = value; }, theme);
    // React Aria's virtual-focus combobox deliberately leaves hidden content in the tab order.
    const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).disableRules(["aria-hidden-focus"]).analyze();
    expect(violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
  }
  await page.getByRole("option", { name: "Namesake · HR" }).click();
  await page.getByRole("option").first().waitFor({ state: "hidden" });
  await expect.poll(() => page.locator("#already-inert").evaluate((el) => !!el.closest("[inert]"))).toBe(true);
  await page.getByRole("button", { name: "Outside", exact: true }).focus();
  expect(await page.getByRole("button", { name: "Outside", exact: true }).evaluate((el) => el === document.activeElement)).toBe(true);
}, 30000);

test("a deliberately selected namesake without an employee number can be confirmed", async () => {
  await page.goto(`${server.resolvedUrls!.local[0]}picker-test`);
  await page.getByRole("combobox", { name: "Person" }).fill("Namesake");
  await page.getByRole("option", { name: "Namesake · Sales" }).click();
  await page.waitForFunction(() => document.querySelector("#selected")?.textContent === "b");
  expect(await page.locator("#selected").textContent()).toBe("b");
}, 10000);

test("one outside click activates its control while the picker is open", async () => {
  await page.goto(`${server.resolvedUrls!.local[0]}picker-test`);
  await page.getByRole("combobox", { name: "Person" }).fill("Namesake");
  await page.getByRole("option").first().waitFor();
  const bounds = await page.locator("#outside").boundingBox();
  await page.mouse.click(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2);
  await expect.poll(() => page.locator("#clicks").textContent()).toBe("1");
  await page.getByRole("option").first().waitFor({ state: "hidden" });
}, 30000);

test("Tab and Shift+Tab leave an open picker for the adjacent controls", async () => {
  await page.goto(`${server.resolvedUrls!.local[0]}picker-test`);
  const input = page.getByRole("combobox", { name: "Person" });
  for (const [key, target] of [["Tab", "#after"], ["Shift+Tab", "#outside"]] as const) {
    await input.fill("Namesake");
    await page.getByRole("option").first().waitFor();
    await input.press(key);
    await expect.poll(() => page.evaluate(() => document.activeElement?.id), { message: key }).toBe(target.slice(1));
    await page.getByRole("option").first().waitFor({ state: "hidden" });
    await input.clear();
  }
}, 30000);

test("a custom person label shows its employee number only once", async () => {
  await page.goto(`${server.resolvedUrls!.local[0]}picker-test`);
  await page.getByRole("combobox", { name: "Person" }).fill("Coded");
  const option = page.getByRole("option", { name: "Coded · E-3" });
  expect((await option.textContent())?.match(/E-3/g)).toHaveLength(1);
}, 10000);
