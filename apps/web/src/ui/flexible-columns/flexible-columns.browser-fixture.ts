// SPDX-License-Identifier: LicenseRef-Proprietary
import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, onTestFailed } from "vitest";
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
    fixture = await loadFixture();
  }, 60_000);

  async function loadFixture() {
    const page = await browser.newPage();
    await page.route("**/columns-test*", route => route.fulfill({ contentType: "text/html", body: '<html lang="ko"><title>Columns</title><div id="root"></div><script type="module" src="/flexible-columns-test.js"></script></html>' }));
    await openBrowserTestPage(page, `${server.resolvedUrls!.local[0]}columns-test`, page.locator('[data-row-id="a"]'));
    return page;
  }

  afterAll(async () => { await browser?.close(); await server?.close(); });

  beforeEach(async () => {
    if (fixture.isClosed()) fixture = await loadFixture();
    // A timed-out Playwright action must stop before it can target the next mount.
    const page = fixture;
    onTestFailed(() => page.close());
  });

  return async (width = 1440, search = "") => {
    const page = fixture;
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(query => (window as unknown as { mountColumns(search: string): void }).mountColumns(query), search);
    return page;
  };
}
