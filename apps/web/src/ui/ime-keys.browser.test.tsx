// SPDX-License-Identifier: LicenseRef-Proprietary
import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import { afterAll, beforeAll, test } from "vitest";
import { expect as element } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { browserTestOptimizeDeps, chromium, type Browser, type Page } from "../lib/browser-test";

const [fixture] = Object.values(import.meta.glob<string>("./ime-keys.browser-fixture.tsx", { query: "?url", import: "default", eager: true }));
let server: ViteDevServer;
let browser: Browser;
let page: Page;
beforeAll(async () => {
  server = await createServer({ configFile: false, cacheDir: ".cache/ime-keys-test", logLevel: "error",
    optimizeDeps: { ...browserTestOptimizeDeps, entries: ["apps/web/src/ui/ime-keys.browser-fixture.tsx"] },
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, fs: { allow: [process.cwd(), dirname(realpathSync("node_modules/pretendard"))] } },
  });
  await server.listen();
  browser = await chromium.launch();
  page = await browser.newPage();
  await page.route("**/ime-test*", route => route.fulfill({ contentType: "text/html", body: `<html lang="ko"><title>IME keys</title><div id="root"></div><script type="module" src="${fixture}"></script></html>` }));
}, 60_000);
afterAll(async () => { await browser?.close(); await server?.close(); });

// The two ways a browser marks a key the input method owns: mid-composition, and the Enter that ends a composition
// (reported after compositionend, with only the key code set).
const IME = [{ isComposing: true, keyCode: 13 }, { isComposing: false, keyCode: 229 }];

test.each(IME)("the find box leaves an input-method Enter %j alone, then acts on a plain Enter", async state => {
  await page.goto(`${server.resolvedUrls!.local[0]}ime-test?case=palette`);
  const box = page.getByRole("searchbox", { name: "Find a person" });
  await box.focus();
  await box.dispatchEvent("keydown", { key: "Enter", ...state });
  await box.dispatchEvent("keydown", { key: "ArrowDown", ...state });
  await element(page.locator("#acted")).toHaveText("0");
  await element(box).toBeFocused();
  await box.press("Enter");
  await element(page.locator("#acted")).toHaveText("1");
});

test.each(IME)("the grid editor leaves input-method keys %j alone, then commits on a plain Enter", async state => {
  await page.goto(`${server.resolvedUrls!.local[0]}ime-test?case=grid`);
  const editor = page.getByRole("textbox");
  await element(editor).toBeFocused();
  for (const key of ["Enter", "Tab", "Escape"]) await editor.dispatchEvent("keydown", { key, ...state });
  await element(page.locator("#committed")).toHaveText("0");
  await element(page.locator("#open")).toHaveText("open");
  await editor.press("Enter");
  await element(page.locator("#committed")).toHaveText("1");
});
