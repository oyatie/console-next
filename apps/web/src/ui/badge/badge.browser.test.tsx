// SPDX-License-Identifier: LicenseRef-Proprietary
import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import { loadCatalog } from "@console/i18n";
import { browserEngine, browserTestOptimizeDeps, type Browser, type BrowserContext, type Page } from "../../lib/browser-test";

let server: ViteDevServer;
let browser: Browser;
let context: BrowserContext;
let page: Page;

beforeAll(async () => {
  await loadCatalog("ko");
  server = await createServer({
    configFile: false,
    cacheDir: ".cache/badge-chrome-test",
    logLevel: "error",
    optimizeDeps: browserTestOptimizeDeps,
    resolve: { dedupe: ["react", "react-dom"] },
    server: {
      host: "127.0.0.1",
      port: 0,
      watch: null,
      hmr: false,
      fs: { allow: [resolve("."), dirname(realpathSync("node_modules/pretendard"))] },
    },
    plugins: [{
      name: "badge-chrome-test",
      resolveId: id => id === "/badge-chrome-test.js" ? "\0badge-chrome-test" : undefined,
      load: id => id === "\0badge-chrome-test" ? `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { loadCatalog } from '@console/i18n';
        import '/apps/web/src/app.css';
        import '/apps/web/src/gallery/gallery.css';
        await loadCatalog('ko');
        const { default: Gallery } = await import('/apps/web/src/ui/badge/badge.gallery.tsx');
        createRoot(document.getElementById('root')).render(React.createElement('main', null, React.createElement(Gallery)));
      ` : undefined,
    }],
  });
  await server.listen();
  browser = await browserEngine().launch();
  context = await browser.newContext();
  page = await context.newPage();
  await page.route("**/badge-chrome-test", route => route.fulfill({
    contentType: "text/html",
    body: '<html lang="ko"><title>Badge and Chrome</title><div id="root"></div><script type="module" src="/badge-chrome-test.js"></script></html>',
  }));
  await page.goto(`${server.resolvedUrls!.local[0]}badge-chrome-test`);
  await page.locator("[data-surface='chrome']").waitFor();
  await page.evaluate(async () => { await document.fonts.ready; });
}, 60_000);

afterAll(async () => {
  await page?.close();
  await context?.close();
  await browser?.close();
  await server?.close();
});

test("frame scope, Badge, Kbd, and Avatar pass WCAG 2.2 AA axe checks and resolve exact geometry per experience", async () => {
  for (const experience of ["baseline", "console"] as const) {
    for (const theme of ["light", "dark"] as const) {
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await page.evaluate(([exp, thm]) => {
          document.documentElement.dataset.experience = exp;
          document.documentElement.dataset.theme = thm;
        }, [experience, theme] as const);

        const scan = await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
          .analyze();
        expect(scan.violations, `${experience} ${theme} ${width}px axe violations`).toEqual([]);

        const metrics = await page.evaluate(() => {
          const chrome = document.querySelector<HTMLElement>("[data-surface='chrome']")!;
          const kbd = chrome.querySelector<HTMLElement>("kbd")!;
          const avatar = chrome.querySelector<HTMLElement>("[data-tone='accent']")!;
          return {
            chromeBg: getComputedStyle(chrome).backgroundColor,
            kbdHeight: Math.round(kbd.getBoundingClientRect().height),
            avatarRadius: getComputedStyle(avatar).borderTopLeftRadius,
          };
        });

        if (experience === "baseline") {
          expect(metrics.kbdHeight).toBe(20);
          expect(metrics.avatarRadius).toBe("50%");
        } else {
          expect(metrics.chromeBg).toBe(theme === "light" ? "rgb(21, 32, 43)" : "rgb(10, 16, 23)");
          expect(metrics.kbdHeight).toBe(16);
          expect(metrics.avatarRadius).toBe("2px");
        }
      }
    }
  }
});
