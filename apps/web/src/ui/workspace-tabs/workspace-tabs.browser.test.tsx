// SPDX-License-Identifier: LicenseRef-Proprietary
import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import { loadCatalog, t } from "@console/i18n";
import { tg } from "@console/i18n/gallery";
import { browserEngine, browserTestOptimizeDeps, type Browser, type BrowserContext, type Page } from "../../lib/browser-test";

let server: ViteDevServer;
let browser: Browser;
let context: BrowserContext;
let page: Page;

beforeAll(async () => {
  await loadCatalog("ko");
  server = await createServer({
    configFile: false,
    cacheDir: ".cache/workspace-tabs-test",
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
      name: "workspace-tabs-test",
      resolveId: id => id === "/workspace-tabs-test.js" ? "\0workspace-tabs-test" : undefined,
      load: id => id === "\0workspace-tabs-test" ? `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { loadCatalog } from '@console/i18n';
        import '/apps/web/src/app.css';
        import '/apps/web/src/gallery/gallery.css';
        await loadCatalog('ko');
        const { default: Gallery } = await import('/apps/web/src/ui/workspace-tabs/workspace-tabs.gallery.tsx');
        createRoot(document.getElementById('root')).render(React.createElement('main', null, React.createElement(Gallery)));
      ` : undefined,
    }],
  });
  await server.listen();
  browser = await browserEngine().launch();
  context = await browser.newContext();
  page = await context.newPage();
  await page.route("**/workspace-tabs-test", route => route.fulfill({
    contentType: "text/html",
    body: '<html lang="ko"><title>WorkspaceTabs</title><div id="root"></div><script type="module" src="/workspace-tabs-test.js"></script></html>',
  }));
  await page.goto(`${server.resolvedUrls!.local[0]}workspace-tabs-test`);
  await page.locator("[data-workspace-tabs-gallery]").waitFor();
  await page.evaluate(async () => { await document.fonts.ready; });
}, 60_000);

afterAll(async () => {
  await page?.close();
  await context?.close();
  await browser?.close();
  await server?.close();
});

test("WorkspaceTabs passes WCAG 2.2 AA axe checks, meets target sizes, handles keyboard navigation, and folds overflow", async () => {
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
      }
    }
  }

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => {
    document.documentElement.dataset.experience = "console";
    document.documentElement.dataset.theme = "light";
  });

  const full = page.locator("[data-workspace-tabs-demo='full']");
  const geometry = await full.evaluate(root => {
    const nav = root.querySelector("nav")!;
    const closeBtn = root.querySelector<HTMLButtonElement>("ul button")!;
    return {
      stripHeight: Math.round(nav.getBoundingClientRect().height),
      closeWidth: Math.round(closeBtn.getBoundingClientRect().width),
      closeHeight: Math.round(closeBtn.getBoundingClientRect().height),
    };
  });
  expect(geometry.stripHeight).toBe(32);
  expect(geometry.closeWidth).toBe(24);
  expect(geometry.closeHeight).toBe(24);

  // ArrowRight / End / Home move focus across tab links; IME Process key is ignored.
  const firstLink = full.locator("ul a").first();
  await firstLink.focus();
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => page.evaluate(() => document.activeElement?.textContent)).toBe(t("shell.link.people"));

  await page.evaluate(() => {
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Process", keyCode: 229, bubbles: true }),
    );
  });
  await expect.poll(() => page.evaluate(() => document.activeElement?.textContent)).toBe(t("shell.link.people"));

  await page.keyboard.press("Home");
  await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute("href"))).toBe("#todo");

  // Closing the active tab moves focus to an adjacent surviving tab link instead of dropping focus to <body>.
  const closePerson = full.getByRole("button", { name: t("shell.tabs.closeOne", { name: tg("search.person") }) });
  await closePerson.click();
  await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).toBe("A");

  // Narrow overflow keeps the active tab inline and exposes remaining tabs via ActionMenu.
  const narrow = page.locator("[data-workspace-tabs-demo='narrow']");
  await expect.poll(async () => await narrow.locator("ul a[aria-current='page']").textContent()).toBe(t("shell.link.payroll"));
  const narrowTailFits = await narrow.evaluate(root => {
    const nav = root.querySelector("nav")!;
    const measureTail = nav.querySelector<HTMLElement>("[inert] > :last-child")!;
    const rect = measureTail.getBoundingClientRect();
    return {
      measureTailWidth: Math.round(rect.width),
      measureTailScrollWidth: Math.round(measureTail.scrollWidth),
      navFits: nav.scrollWidth <= nav.clientWidth,
    };
  });
  expect(narrowTailFits.measureTailWidth).toBeGreaterThanOrEqual(narrowTailFits.measureTailScrollWidth);
  expect(narrowTailFits.navFits).toBe(true);
});
