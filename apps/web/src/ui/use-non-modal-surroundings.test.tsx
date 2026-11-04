// SPDX-License-Identifier: LicenseRef-Proprietary
import { AxeBuilder } from "@axe-core/playwright";
import { chromium, expect as expectElement, type Browser, type Page } from "@playwright/test";
import type { ViteDevServer } from "vite";
import { afterAll, beforeAll, expect, test } from "vitest";
import { pickerTestServer } from "./server-picker/browser-test";

let server: ViteDevServer;
let browser: Browser;
let page: Page;

beforeAll(async () => {
  server = await pickerTestServer("reference-picker-test", `
    import { createElement as h, useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { loadCatalog } from '@console/i18n';
    import { CodePicker } from '/apps/web/src/ui/code-picker/code-picker.tsx';
    import { AddressField } from '/apps/web/src/ui/address-field/address-field.tsx';
    import { UnitPicker } from '/apps/web/src/reference/org/ui/unit-picker.tsx';
    import '/apps/web/src/app.css';
    await loadCatalog('en');
    const units = [{ id: 'hr', kind: 'DEPARTMENT', name: 'HR', parentId: null,
      status: 'ACTIVE', effectiveFrom: '2026-01-01', headcount: 0, updatedAt: '2026-01-01T00:00:00Z' }];
    function Picker() {
      const [query, onQueryChange] = useState('');
      const [value, onChange] = useState(null);
      const kind = new URLSearchParams(location.search).get('kind');
      const picker = kind === 'code' ? h(CodePicker, { label: 'Code', required: true,
        query, onQueryChange, value, onChange, list: { title: 'Codes', loaded: true },
        options: [{ code: 'HR', label: 'HR' }] })
        : kind === 'address' ? h(AddressField, { label: 'Address', required: true,
          query, onQueryChange, value, onChange,
          hits: [{ key: 'road', road: 'HR Road', jibun: 'HR Lot', zip: '03154' }] })
        : h(UnitPicker, { labelText: 'Unit', units, options: units, value: value ?? '', onChange });
      return h('main', null,
        h('button', { id: 'before' }, 'Before'),
        h('section', { id: 'hidden', 'aria-hidden': true }, 'Decoration'),
        h('div', { id: 'restricted', inert: true }, h('button', null, 'Unavailable')),
        picker, h('button', { id: 'after' }, 'After'));
    }
    createRoot(document.getElementById('root')).render(h(Picker));
  `);
  browser = await chromium.launch();
  page = await (await browser.newContext()).newPage();
}, 60_000);

afterAll(async () => { await browser?.close(); await server?.close(); });

for (const kind of ["code", "address", "unit"]) test.each([1440, 390])(
  `an open ${kind} picker exposes adjacent controls at %i px and restores restrictions on close`, async width => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${server.resolvedUrls!.local[0]}reference-picker-test?kind=${kind}`);
    const input = page.getByRole("combobox");
    await input.fill("HR");
    await page.getByRole("option").first().waitFor();
    for (const theme of ["light", "dark"]) {
      await page.locator("html").evaluate((el, value) => { el.dataset.theme = value; }, theme);
      const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
      expect(violations.filter(v => v.impact === "serious" || v.impact === "critical")).toEqual([]);
    }
    await expectElement(page.locator("#hidden")).toHaveAttribute("aria-hidden", "true");
    await expectElement(page.locator("#before")).not.toHaveAttribute("aria-hidden", "true");
    await input.press("Shift+Tab");
    await expectElement(page.locator("#before")).toBeFocused();
    await expectElement(input).toHaveAttribute("aria-expanded", "false");
    await expectElement(page.getByRole("listbox")).toHaveCount(0);
    await expectElement(page.locator("#restricted")).toHaveJSProperty("inert", true);
  }, 30_000,
);
