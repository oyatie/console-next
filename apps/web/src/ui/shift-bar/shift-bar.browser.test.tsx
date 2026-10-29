// SPDX-License-Identifier: LicenseRef-Proprietary
import { afterAll, beforeAll, expect, test } from "vitest";
import { expect as element } from "@playwright/test";
import { chromium, type Browser, type Page } from "../../lib/browser-test";
import { pickerTestServer } from "../server-picker/browser-test";

let server: Awaited<ReturnType<typeof pickerTestServer>>;
let browser: Browser;
let page: Page;
beforeAll(async () => {
  server = await pickerTestServer("shift-bars", `
    import { createElement as h } from 'react';
    import { createRoot } from 'react-dom/client';
    import { loadCatalog } from '@console/i18n';
    import Gallery from '/apps/web/src/ui/shift-bar/shift-bar.gallery.tsx';
    import '/apps/web/src/app.css';
    await loadCatalog('ko');
    createRoot(document.getElementById('root')).render(h(Gallery));
  `);
  browser = await chromium.launch();
  page = await browser.newPage();
}, 60_000);
afterAll(async () => { await browser?.close(); await server?.close(); });
test.each([1440, 390])("gallery bars share one scale, words and the equivalent table at %spx", async width => {
  await page.setViewportSize({ width, height: 900 });
  const port = (server.httpServer!.address() as { port: number }).port;
  await page.goto(`http://localhost:${port}/shift-bars`);
  await element(page.getByText("예정", { exact: true }).first()).toBeVisible();
  await element(page.getByRole("table", { name: "근무 시간 구간", exact: true }).locator("tbody tr")).toHaveCount(3);
  const boxes = await page.locator('svg[viewBox$=" 20"]').evaluateAll(bars => bars.map(bar => bar.getAttribute("viewBox")));
  expect(boxes).toHaveLength(3);
  expect(new Set(boxes).size).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
});
