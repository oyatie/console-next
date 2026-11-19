// SPDX-License-Identifier: LicenseRef-Proprietary
import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import { loadCatalog, t } from "@console/i18n";
import { browserEngine, browserTestOptimizeDeps, openBrowserTestPage, type Browser, type BrowserContext, type Page } from "../../lib/browser-test";

let server: ViteDevServer;
let browser: Browser;
let context: BrowserContext;
let page: Page;

beforeAll(async () => {
  await loadCatalog("ko");
  server = await createServer({
    configFile: false,
    cacheDir: ".cache/console-shell-shortcut-test",
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
      name: "console-shell-shortcut-test",
      resolveId: id => id === "/console-shell-shortcut-test.js" ? "\0console-shell-shortcut-test" : undefined,
      load: id => id === "\0console-shell-shortcut-test" ? `
        import React, { useEffect, useState } from 'react';
        import { createRoot } from 'react-dom/client';
        import { loadCatalog } from '@console/i18n';
        import { singleKeysOn } from '/apps/web/src/lib/prefs.ts';
        import { isImeKey } from '/apps/web/src/lib/pure/ime.ts';
        import { singleKey } from '/apps/web/src/lib/pure/keys.ts';
        import { editable } from '/apps/web/src/ui/long-table/row-keys.ts';
        import '/apps/web/src/app.css';
        await loadCatalog('ko');
        function Harness() {
          const [withFind, setWithFind] = useState(false);
          const [searchOpens, setSearchOpens] = useState(0);
          useEffect(() => {
            const onKeyDown = event => {
              if (event.defaultPrevented || isImeKey(event)) return;
              if (!singleKey(event) || event.key !== '/') return;
              if (!singleKeysOn() || editable(event.target)) return;
              if (document.querySelector('[role=dialog], [role=alertdialog]') !== null) return;
              event.preventDefault();
              const mainEl = document.getElementById('main');
              const inPageFind = mainEl?.querySelector('[data-list-find] input, input[type="search"]');
              if (inPageFind && inPageFind.offsetParent !== null) {
                inPageFind.focus();
                return;
              }
              setSearchOpens(n => n + 1);
            };
            document.addEventListener('keydown', onKeyDown);
            return () => document.removeEventListener('keydown', onKeyDown);
          }, []);
          return React.createElement('main', { id: 'main', 'data-shell-harness': '' },
            React.createElement('output', { 'data-opens': '' }, String(searchOpens)),
            React.createElement('button', { type: 'button', onClick: () => setWithFind(v => !v) }, 'toggle'),
            React.createElement('input', { 'aria-label': 'plain' }),
            withFind ? React.createElement('div', { 'data-list-find': '' }, React.createElement('input', { type: 'search', 'aria-label': 'find' })) : null,
          );
        }
        createRoot(document.getElementById('root')).render(React.createElement(Harness));
      ` : undefined,
    }],
  });
  await server.listen();
  browser = await browserEngine().launch();
  context = await browser.newContext();
  page = await context.newPage();
  await page.route("**/console-shell-shortcut-test", route => route.fulfill({
    contentType: "text/html",
    body: '<html lang="ko"><title>Console Shell</title><div id="root"></div><script type="module" src="/console-shell-shortcut-test.js"></script></html>',
  }));
  await openBrowserTestPage(page, `${server.resolvedUrls!.local[0]}console-shell-shortcut-test`, page.locator("[data-shell-harness]"));
}, 60_000);

afterAll(async () => {
  await page?.close();
  await context?.close();
  await browser?.close();
  await server?.close();
});

test("slash shortcut opens search, yields to in-page find, and respects singleKeysOn and input focus", async () => {
  expect(t("shell.scope.allEntities")).toBeTruthy();

  await page.keyboard.press("/");
  await expect.poll(async () => await page.locator("[data-opens]").textContent()).toBe("1");

  // Inside an input, `/` types into the input rather than opening global search.
  const plainInput = page.getByLabel("plain");
  await plainInput.focus();
  await page.keyboard.press("/");
  await expect.poll(async () => await page.locator("[data-opens]").textContent()).toBe("1");

  // With an in-page find field visible, `/` focuses that find field instead of opening global search.
  await page.getByRole("button", { name: "toggle" }).click();
  await page.getByRole("button", { name: "toggle" }).focus();
  await page.keyboard.press("/");
  await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("find");
  await expect.poll(async () => await page.locator("[data-opens]").textContent()).toBe("1");

  // With single-key shortcuts disabled on the device ("off"), `/` does not act.
  await page.evaluate(() => localStorage.setItem("console.singleKeys", "off"));
  await page.getByRole("button", { name: "toggle" }).click();
  await page.getByRole("button", { name: "toggle" }).focus();
  await page.keyboard.press("/");
  await expect.poll(async () => await page.locator("[data-opens]").textContent()).toBe("1");
});
