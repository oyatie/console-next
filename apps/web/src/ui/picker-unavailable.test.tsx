// SPDX-License-Identifier: LicenseRef-Proprietary
import { chromium, type Browser, type Page } from "@playwright/test";
import type { ViteDevServer } from "vite";
import { afterAll, beforeAll, expect, test } from "vitest";
import { pickerTestServer } from "./server-picker/browser-test";

let server: ViteDevServer;
let browser: Browser;
let page: Page;

beforeAll(async () => {
  server = await pickerTestServer("picker-unavailable-test", `
    import { createElement as h, useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { loadCatalog } from '@console/i18n';
    import { AddressField } from '/apps/web/src/ui/address-field/address-field.tsx';
    import { CodePicker } from '/apps/web/src/ui/code-picker/code-picker.tsx';
    import '/apps/web/src/app.css';
    await loadCatalog('en');
    function Picker() {
      const [query, onQueryChange] = useState('');
      const [value, onChange] = useState(null);
      const [unavailable, setUnavailable] = useState(false);
      window.makeUnavailable = () => setUnavailable(true);
      const kind = new URLSearchParams(location.search).get('kind');
      const props = { required: true, query, onQueryChange, value, onChange };
      return h('main', null,
        h('div', { id: 'probe' }, h('button', null, 'Probe')),
        h('div', { id: 'restricted', inert: true }, h('button', null, 'Unavailable')),
        kind === 'address' ? h(AddressField, { ...props, label: 'Address',
          problem: unavailable ? 'unavailable' : null,
          hits: [{ key: 'road', road: 'HR Road', jibun: 'HR Lot', zip: '03154' }] })
        : h(CodePicker, { ...props, label: 'Code', list: { title: 'Codes', loaded: !unavailable },
          options: [{ code: 'HR', label: 'HR' }] }),
        h('button', { id: 'after' }, 'After'));
    }
    createRoot(document.getElementById('root')).render(h(Picker));
  `);
  browser = await chromium.launch();
  page = await (await browser.newContext()).newPage();
}, 60_000);

afterAll(async () => { await browser?.close(); await server?.close(); });

for (const kind of ["address", "code"]) test(`an unavailable ${kind} search restores restrictions and stops observing its surroundings`, async () => {
  await page.goto(`${server.resolvedUrls!.local[0]}picker-unavailable-test?kind=${kind}`);
  await page.getByRole("combobox").fill("HR");
  await page.getByRole("option").first().waitFor();
  await page.evaluate(() => (window as unknown as { makeUnavailable: () => void }).makeUnavailable());
  await expect.poll(() => page.getByRole("combobox").count()).toBe(0);
  await page.locator("#probe").evaluate(async el => {
    el.setAttribute("aria-hidden", "true");
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  expect.soft(await page.locator("#probe").getAttribute("aria-hidden")).toBe("true");
  expect(await page.locator("#restricted").evaluate(el => (el as HTMLElement).inert)).toBe(true);
}, 30_000);
