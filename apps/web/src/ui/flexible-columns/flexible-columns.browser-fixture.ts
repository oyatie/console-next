// SPDX-License-Identifier: LicenseRef-Proprietary
import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { afterAll, beforeAll, describe, onTestFailed, test } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import { browserEngine, browserTestOptimizeDeps, openBrowserTestPage, type Browser, type Page } from "../../lib/browser-test";

export function columnsFixture(source: string) {
  let server: ViteDevServer;
  let browser: Browser;
  let fixture: Page;

  beforeAll(async () => {
    server = await createServer({
      configFile: false, cacheDir: ".cache/flexible-columns-test", logLevel: "error",
      optimizeDeps: browserTestOptimizeDeps, resolve: { dedupe: ["react", "react-dom"] },
      server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, fs: { allow: [resolve("."), dirname(realpathSync("node_modules/pretendard"))] } },
      plugins: [{
        name: "flexible-columns-test",
        resolveId: id => id === "/flexible-columns-test.js" ? "\0flexible-columns-test" : undefined,
        load: id => id === "\0flexible-columns-test" ? source : undefined,
      }],
    });
    await server.listen();
    browser = await browserEngine().launch();
  }, 60_000);
  afterAll(async () => { await browser?.close(); await server?.close(); });

  return (name: string, width: number, run: (page: Page) => Promise<void>, search = "") => {
    describe(`${width}px`, () => {
      let page: Page;
      beforeAll(async () => {
        if (!fixture || fixture.isClosed()) {
          fixture = await browser.newPage();
          await fixture.route("**/columns-test*", route => route.fulfill({ contentType: "text/html", body: '<html lang="ko"><title>Columns</title><div id="root"></div><script type="module" src="/flexible-columns-test.js"></script></html>' }));
          await openBrowserTestPage(fixture, `${server.resolvedUrls!.local[0]}columns-test`, fixture.locator('[data-row-id="a"]'));
        }
        page = fixture;
        await page.setViewportSize({ width, height: 900 });
        await page.evaluate(query => (window as unknown as { mountColumns(search: string): void }).mountColumns(query), search);
      }, 60_000);
      test(name, async () => {
        // Pending Playwright actions can outlive a timed-out test.
        onTestFailed(() => page.close());
        await run(page);
      });
    });
  };
}
