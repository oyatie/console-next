// SPDX-License-Identifier: LicenseRef-Proprietary
import { chromium, expect as expectElement, type Browser, type Page } from "@playwright/test";
import { afterAll, beforeAll, expect, test } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import type { ViteDevServer } from "vite";
import { pickerTestServer } from "./browser-test";

let server: ViteDevServer;
let browser: Browser;
let page: Page;
beforeAll(async () => {
  await loadCatalog("ko");
  server = await pickerTestServer("picker-feedback", `
    import { createElement as h, useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { loadCatalog, t } from '@console/i18n';
    import { ServerPicker } from '/apps/web/src/ui/server-picker/server-picker.tsx';
    import '/apps/web/src/app.css';
    await loadCatalog('ko');
    function Fixture() {
      const [state, setState] = useState('loading');
      window.finishRead = () => setState('populated');
      window.failRead = () => setState('failed');
      const props = { group: 'People', empty: 'No people', query: '', onQueryChange: () => {}, options: [], value: null, onChange: () => {} };
      return h('main', null,
        h('section', { id: 'form' }, h(ServerPicker, { ...props, label: 'Form person' })),
        h('section', { id: 'read' }, h(ServerPicker, { ...props, label: 'Search people', reserveError: true, loading: state === 'loading', error: state === 'failed' ? t('common.read.failedReason') : undefined })),
        h('input', { id: 'after', 'aria-label': 'After' }));
    }
    createRoot(document.getElementById('root')).render(h(Fixture));
  `);
  browser = await chromium.launch();
  page = await browser.newPage();
}, 60_000);
afterAll(async () => { await browser?.close(); await server?.close(); });

for (const width of [1440, 390]) test(`only a page read reserves one feedback line at ${width}px`, async () => {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`${server.resolvedUrls!.local[0]}picker-feedback`);
  await expectElement(page.getByRole("combobox", { name: "Form person", exact: true })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  const natural = await page.locator("#form .field").boundingBox();
  expect(natural!.height).toBe(await page.locator("#form .field").evaluate(el =>
    el.querySelector("label")!.getBoundingClientRect().height + el.querySelector("input")!.parentElement!.getBoundingClientRect().height + parseFloat(getComputedStyle(el).rowGap)));
  expect(await page.locator("#form .field").locator(":scope > *").count()).toBe(2);
  const before = await page.locator("#after").boundingBox();
  const reserved = await page.locator("#read .field").boundingBox();
  const line = await page.locator("#read .field").evaluate(el =>
    parseFloat(getComputedStyle(el.lastElementChild!).lineHeight) + parseFloat(getComputedStyle(el).rowGap));
  expect(reserved!.height - natural!.height).toBeCloseTo(line, 0);
  await page.evaluate(() => (window as unknown as { finishRead: () => void }).finishRead());
  await expectElement(page.getByRole("combobox", { name: "Search people", exact: true })).not.toHaveAttribute("aria-invalid", "true");
  expect(await page.locator("#after").boundingBox()).toEqual(before);
  await page.evaluate(() => (window as unknown as { failRead: () => void }).failRead());
  const search = page.getByRole("combobox", { name: "Search people", exact: true });
  await expectElement(search).toHaveAttribute("aria-invalid", "true");
  await expectElement(search).toHaveAccessibleDescription(t("common.read.failedReason"));
  expect(await page.locator("#after").boundingBox()).toEqual(before);
});
