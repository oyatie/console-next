// SPDX-License-Identifier: LicenseRef-Proprietary
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import { browserTestOptimizeDeps, chromium, type Browser, type Page } from "../../lib/browser-test";

let server: ViteDevServer;
let browser: Browser;
let page: Page;
beforeAll(async () => {
  server = await createServer({ configFile: false, cacheDir: ".cache/choice-test", logLevel: "error", optimizeDeps: browserTestOptimizeDeps,
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, fs: { allow: [resolve("."), realpathSync("node_modules/pretendard")] } },
    plugins: [{ name: "choice-test", resolveId: id => id === "/choice-test.js" ? "\0choice-test" : undefined,
      load: id => id === "\0choice-test" ? `
        import { createElement, useState } from 'react'; import { createRoot } from 'react-dom/client';
        import { loadCatalog } from '@console/i18n';
        import { ChoiceField } from '/apps/web/src/ui/choice/choice-field.tsx';
        import '/apps/web/src/app.css';
        await loadCatalog('ko');
        function App() {
          const [value, onChange] = useState(null);
          return createElement(ChoiceField, { label: '배치', required: false, look: 'chips', value, onChange,
            options: [{ value: 'unit', label: '부서' }, { value: 'site', label: '사업장 직속 · 부서 없이' }, { value: 'none', label: '나중에 배치' }] });
        }
        createRoot(document.getElementById('root')).render(createElement(App));
      ` : undefined }],
  });
  await server.listen(); browser = await chromium.launch(); page = await browser.newPage();
  await page.route("**/choice-test", route => route.fulfill({ contentType: "text/html", body: '<html lang="ko"><title>배치</title><div id="root"></div><script type="module" src="/choice-test.js"></script></html>' }));
}, 60_000);
afterAll(async () => { await browser?.close(); await server?.close(); });

test("chip selection reserves the checkmark without moving any option", async () => {
  await page.goto(`${server.resolvedUrls!.local[0]}choice-test`);
  const chips = page.locator("label").filter({ has: page.getByRole("radio") });
  await chips.last().waitFor();
  await page.evaluate(() => document.fonts.ready);
  const geometry = () => chips.evaluateAll(elements => elements.map(element => {
    const { x, y, width, height } = element.getBoundingClientRect();
    return { x, y, width, height };
  }));
  const before = await geometry();
  for (const chip of await chips.all()) {
    await chip.click();
    expect(await chip.getByRole("radio").isChecked()).toBe(true);
    expect(await chip.locator("svg").evaluate(element => getComputedStyle(element).visibility)).toBe("visible");
    const tick = await chip.locator("svg").boundingBox();
    expect(tick?.width ?? 0).toBeGreaterThan(0);
    expect(tick?.height ?? 0).toBeGreaterThan(0);
    const unselected = chips.filter({ has: page.getByRole("radio", { checked: false }) });
    for (const otherTick of await unselected.locator("svg").all()) {
      expect(await otherTick.isVisible()).toBe(false);
    }
    expect(await geometry()).toEqual(before);
  }
});
