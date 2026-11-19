// SPDX-License-Identifier: LicenseRef-Proprietary
import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import { loadCatalog, t } from "@console/i18n";
import { browserEngine, browserTestOptimizeDeps, type Browser, type BrowserContext, type Page } from "../../lib/browser-test";

let server: ViteDevServer;
let browser: Browser;
let context: BrowserContext;
let page: Page;

beforeAll(async () => {
  await loadCatalog("ko");
  server = await createServer({
    configFile: false,
    cacheDir: ".cache/module-nav-test",
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
      name: "module-nav-test",
      resolveId: id => id === "/module-nav-test.js" ? "\0module-nav-test" : undefined,
      load: id => id === "\0module-nav-test" ? `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { loadCatalog } from '@console/i18n';
        import '/apps/web/src/app.css';
        import '/apps/web/src/gallery/gallery.css';
        await loadCatalog('ko');
        const { default: Gallery } = await import('/apps/web/src/ui/module-nav/module-nav.gallery.tsx');
        createRoot(document.getElementById('root')).render(React.createElement('main', null, React.createElement(Gallery)));
      ` : undefined,
    }],
  });
  await server.listen();
  browser = await browserEngine().launch();
  context = await browser.newContext();
  page = await context.newPage();
  await page.route("**/module-nav-test", route => route.fulfill({
    contentType: "text/html",
    body: '<html lang="ko"><title>ModuleNavBar</title><div id="root"></div><script type="module" src="/module-nav-test.js"></script></html>',
  }));
  await page.goto(`${server.resolvedUrls!.local[0]}module-nav-test`);
  await page.locator("[data-module-nav-gallery]").waitFor();
  await page.evaluate(async () => { await document.fonts.ready; });
}, 60_000);

afterAll(async () => {
  await page?.close();
  await context?.close();
  await browser?.close();
  await server?.close();
});

test("ModuleNavBar passes WCAG 2.2 AA axe checks and keeps the active module inline when narrow", async () => {
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

  // In the constrained demo, the trailing active item ("settings") remains inline while excess modules fold into overflow.
  const narrow = page.locator("[data-module-nav-demo='narrow']");
  const activeLink = narrow.locator("a[aria-current='page']");
  await expect.poll(async () => await activeLink.textContent()).toBe(t("shell.link.settings"));

  const moreBtn = narrow.getByRole("button", { name: t("shell.nav.more") });
  await moreBtn.click();
  const menuItem = page.getByRole("menuitem", { name: t("shell.link.payroll") });
  await menuItem.click();
  await expect.poll(async () => await narrow.locator("a[aria-current='page']").textContent()).toBe(t("shell.link.payroll"));
});
