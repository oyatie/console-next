// SPDX-License-Identifier: LicenseRef-Proprietary
import { dirname, resolve } from "node:path";
import { realpathSync } from "node:fs";
import { afterAll, beforeAll, expect, test } from "vitest";
import { expect as element } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { browserTestOptimizeDeps, chromium, type Browser, type Page } from "../../lib/browser-test";

let server: ViteDevServer;
let browser: Browser;
let page: Page;
beforeAll(async () => {
  server = await createServer({
    configFile: false, cacheDir: ".cache/tabs-test", logLevel: "error",
    optimizeDeps: browserTestOptimizeDeps, resolve: { dedupe: ["react", "react-dom"] },
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, fs: { allow: [resolve("."), dirname(realpathSync("node_modules/pretendard"))] } },
    plugins: [{ name: "tabs-test", resolveId: id => id === "/tabs-test.js" ? "\0tabs-test" : undefined,
      load: id => id === "\0tabs-test" ? `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { loadCatalog } from '@console/i18n';
        import TabsGallery from '/apps/web/src/ui/tabs/tabs.gallery.tsx';
        import '/apps/web/src/app.css';
        await loadCatalog('ko');
        createRoot(document.getElementById('root')).render(React.createElement(TabsGallery));
      ` : undefined }],
  });
  await server.listen();
  browser = await chromium.launch();
  page = await browser.newPage();
  await page.route("**/tabs-test", route => route.fulfill({ contentType: "text/html", body: '<html lang="ko"><title>Tabs</title><main id="root"></main><script type="module" src="/tabs-test.js"></script></html>' }));
}, 60_000);
afterAll(async () => { await browser?.close(); await server?.close(); });

test.each([1440, 390, 320])("the gallery's record tabs keep their panels outside the shared head at %spx", async width => {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`${server.resolvedUrls!.local[0]}tabs-test`);
  const tabs = page.getByRole("tablist", { name: "보기", exact: true });
  await element(page.locator("header").getByRole("tablist")).toBeVisible();
  const selected = tabs.getByRole("tab", { selected: true });
  await selected.focus();
  await selected.press("ArrowRight");
  await element(selected).toHaveAccessibleName("목록 61");
  await element(page.getByRole("tabpanel")).toHaveText("목록 보기입니다.");
  expect(await page.getByRole("tabpanel").evaluate(el => Boolean(el.closest("header")))).toBe(false);
  await selected.press("End");
  await element(selected).toHaveAccessibleName("아웃라인");
  await selected.press("Home");
  await element(selected).toHaveAccessibleName("조직도");
  await element(tabs.locator('[tabindex="0"]')).toHaveCount(1);
  expect(await page.evaluate(() => document.scrollingElement!.scrollWidth - innerWidth)).toBe(0);
});
