// SPDX-License-Identifier: LicenseRef-Proprietary
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "vitest";
import { chromium, type Browser, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadCatalog } from "@console/i18n";
import type { GridRow } from "./grid-table";

let server: ViteDevServer;
let browser: Browser;
let page: Page;
let errors: string[];

function setupGridFixture(rows2000: readonly GridRow[]) {
  beforeAll(async () => {
    await loadCatalog("en");
    // Mount the real component and GridPage styles; no backend or server-rendered event simulation.
    const entry = `
      import { createRoot } from 'react-dom/client';
      import { i18n, loadCatalog } from '@console/i18n';
      import { GridPage } from '/apps/web/src/features/people/ui/grid-page';
      import { bulkSelection } from '/apps/web/src/features/people/ui/use-bulk-selection';
      import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
      import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from '@tanstack/react-router';
      import { configure } from '@console/api';
      import { webPlatform } from '@console/api/web';
      import '/apps/web/src/app.css';
      await loadCatalog('en');
      i18n.set('en');
      const router = createRouter({routeTree: createRootRoute(), history: createMemoryHistory({initialEntries: ['/']})});
      bulkSelection.set(new Map(${JSON.stringify(rows2000.map((row) => [row.id, row.name]))}));
      configure(webPlatform);
      createRoot(document.getElementById('root')).render(
        <QueryClientProvider client={new QueryClient()}><RouterContextProvider router={router}><GridPage /></RouterContextProvider></QueryClientProvider>
      );
    `;
    server = await createServer({
      configFile: false, root: process.cwd(), cacheDir: ".cache/grid-page-test-vite",
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

const rows2000: readonly GridRow[] = Array.from({ length: 2000 }, (_, i) => ({
  id: `emp-${i + 1}`, number: String(i + 1).padStart(4, "0"), name: `Person ${i + 1} 직원 😀`,
  current: ["MALE", "Seoul", "Developer"], typed: [undefined, undefined, undefined],
  cells: [{ keep: true }, { keep: true }, { keep: true }],
}));

setupGridFixture(rows2000);

test("GridPage Paste focuses row one after it unmounts", async () => {
  await page.goto(`${server.resolvedUrls!.local[0]}__grid-test?page`);
  await page.getByRole("grid").waitFor();
  await page.locator("#grid-0-0").click();
  for (let i = 0; i < 70; i++) await page.keyboard.press("ArrowDown");
  await expect.poll(() => page.evaluate(() => document.activeElement?.closest('[role="gridcell"]')?.id)).toBe("grid-70-0");
  expect(await page.locator("#grid-0-0").count()).toBe(0);
  for (let i = 0; i < 2; i++) {
    await page.getByRole("button", { name: /^Paste/ }).click();
    await expect.poll(() => page.evaluate(() => document.activeElement?.closest('[role="gridcell"]')?.id)).toBe("grid-0-0");
  }
  expect(await page.getByRole("rowheader").count()).toBeLessThanOrEqual(25 + 10);
});

test("GridPage First error reaches an unmounted stale_record refusal", async () => {
  await page.route("**/api/v1/employees/corrections/bulk/preview", (route) => route.fulfill({ json: {
    preview_id: "preview-test", preview_digest: "digest-test", step_up_required: false,
    counts: { selected: 1, change: 0, pending: 0, unchanged: 0, refused: 1 },
    rows: [{ employee_id: "emp-1000", outcome: "REFUSED", fields: [], code: "stale_record", refusals: [{ field: "job", code: "stale_record", message: "Record changed" }] }],
  } }));
  await page.goto(`${server.resolvedUrls!.local[0]}__grid-test?page`, { waitUntil: "domcontentloaded" });
  await page.getByRole("grid").waitFor();
  await page.locator("#grid-0-2").click();
  await page.keyboard.press("F2");
  await page.keyboard.insertText("Updated draft");
  await page.keyboard.press("Enter");
  expect(await page.locator("#grid-0-2").textContent()).toContain("Updated draft");
  expect(await page.locator("footer").getByRole("button").last().getAttribute("aria-disabled"), await page.locator("footer").innerText()).toBeNull();
  await page.getByRole("button", { name: "Check", exact: true }).click();
  await page.getByRole("button", { name: "Back to editing" }).click();
  expect(await page.locator("#grid-999-2").count()).toBe(0);
  await page.getByRole("button", { name: "Fix errors first" }).click();
  await expect.poll(() => page.evaluate(() => document.activeElement?.closest('[role="gridcell"]')?.id)).toBe("grid-999-2");
  expect(await page.locator("#grid-999-2").getAttribute("aria-invalid")).toBe("true");
  expect(await page.getByRole("rowheader").count()).toBeLessThanOrEqual(25 + 10);
  await page.getByRole("button", { name: /^Changed/ }).click();
  expect(await page.locator("#grid-999-2").count()).toBe(0);
  await page.getByRole("button", { name: "Fix errors first" }).click();
  await expect.poll(() => page.evaluate(() => document.activeElement?.closest('[role="gridcell"]')?.id)).toBe("grid-999-2");
});

test("GridPage keeps the last focused cell above the footer and its header in view", async () => {
  await page.goto(`${server.resolvedUrls!.local[0]}__grid-test?page`);
  await page.getByRole("grid").focus();
  await page.keyboard.press("Control+End");
  await expect.poll(() => page.locator("#grid-1999-2 input").evaluate((el) => el === document.activeElement)).toBe(true);
  const bounds = await page.locator("#grid-1999-2").evaluate((el) => {
    const cell = el.getBoundingClientRect();
    const bar = document.querySelector('footer')!.getBoundingClientRect();
    const header = document.querySelector('[role="columnheader"]')!.getBoundingClientRect();
    return { cellBottom: cell.bottom, cellTop: cell.top, barTop: bar.top, barBottom: bar.bottom, headerTop: header.top, headerBottom: header.bottom };
  });
  expect(bounds.cellBottom).toBeLessThanOrEqual(bounds.barTop);
  expect(bounds.barBottom).toBeLessThanOrEqual(800);
  expect(bounds.headerTop).toBeGreaterThanOrEqual(0);
  expect(bounds.headerBottom).toBeLessThanOrEqual(bounds.cellTop);
  expect(await page.getByRole("rowheader").count()).toBeLessThanOrEqual(25 + 10);
});
