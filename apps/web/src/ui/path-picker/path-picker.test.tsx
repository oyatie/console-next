// SPDX-License-Identifier: LicenseRef-Proprietary
import { AxeBuilder } from "@axe-core/playwright";
import { chromium, expect as expectElement, type Browser, type Page } from "@playwright/test";
import type { ViteDevServer } from "vite";
import { afterAll, beforeAll, expect, test } from "vitest";
import { pickerTestServer } from "../server-picker/browser-test";

let server: ViteDevServer;
let browser: Browser;
let page: Page;

beforeAll(async () => {
  server = await pickerTestServer("path-picker-test", `
    import { createElement as h, useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { loadCatalog } from '@console/i18n';
    import { PathPicker } from '/apps/web/src/ui/path-picker/path-picker.tsx';
    import '/apps/web/src/app.css';
    await loadCatalog('en');
    function Picker() {
      const [value, onChange] = useState('');
      return h('main', null,
        h('button', { id: 'before' }, 'Before'),
        h('section', { id: 'hidden', 'aria-hidden': true }, 'Decoration'),
        h('div', { inert: true }, h('button', { id: 'restricted' }, 'Unavailable')),
        h(PathPicker, { label: 'Place', placeholder: 'Find a place', openLabel: 'Open places', value, onChange,
          options: [{ id: 'hr', text: 'Company › HR' }, { id: 'sales', text: 'Company › Sales' }] }),
        h('button', { id: 'after' }, 'After'));
    }
    createRoot(document.getElementById('root')).render(h(Picker));
  `);
  browser = await chromium.launch();
  page = await (await browser.newContext()).newPage();
}, 60_000);

afterAll(async () => { await browser?.close(); await server?.close(); });

test.each([1440, 390])("an open path picker exposes adjacent controls at %i px and restores restrictions on close", async width => {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`${server.resolvedUrls!.local[0]}path-picker-test`);
  const input = page.getByRole("combobox", { name: "Place", exact: true });
  await page.getByRole("button", { name: "Open places" }).click();
  await page.getByRole("option").first().waitFor();
  for (const theme of ["light", "dark"]) {
    await page.locator("html").evaluate((el, value) => { el.dataset.theme = value; }, theme);
    const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    expect(violations.filter(v => v.impact === "serious" || v.impact === "critical")).toEqual([]);
  }
  await expectElement(page.locator("#hidden")).toHaveAttribute("aria-hidden", "true");
  await page.getByRole("option", { name: "Company › HR" }).click();
  await expectElement(input).toHaveValue("Company › HR");
  await expectElement(page.locator("#restricted").locator("..")).toHaveJSProperty("inert", true);
  await input.press("ArrowDown");
  await page.getByRole("option").first().waitFor();
  await input.press("Shift+Tab");
  await expectElement(page.locator("#before")).toBeFocused();
  await expectElement(input).toHaveAttribute("aria-expanded", "false");
}, 30_000);
