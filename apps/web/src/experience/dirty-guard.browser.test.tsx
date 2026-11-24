// SPDX-License-Identifier: LicenseRef-Proprietary
import { afterAll, beforeAll, expect, test } from "vitest";
import { expect as element } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { browserTestOptimizeDeps, chromium, openBrowserTestPage, type Browser, type Page } from "../lib/browser-test";

const [fixture] = Object.values(import.meta.glob<string>("./dirty-guard.browser-fixture.tsx", { query: "?url", import: "default", eager: true }));
let server: ViteDevServer;
let browser: Browser;
let page: Page;
beforeAll(async () => {
  server = await createServer({ configFile: false, cacheDir: ".cache/dirty-guard-test", logLevel: "error",
    optimizeDeps: { ...browserTestOptimizeDeps, entries: ["apps/web/src/experience/dirty-guard.browser-fixture.tsx"] },
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, fs: { allow: [process.cwd()] } },
  });
  await server.listen();
  browser = await chromium.launch();
  page = await browser.newPage();
  await page.route("**/dirty-guard-test", route => route.fulfill({ contentType: "text/html", body: `<html lang="en"><title>Dirty guard</title><div id="root"></div><script type="module" src="${fixture}"></script></html>` }));
}, 60_000);
afterAll(async () => { await browser?.close(); await server?.close(); });

// Each case loads afresh: the tracker keeps what it recorded for the life of the page.
const load = () => openBrowserTestPage(page, `${server.resolvedUrls!.local[0]}dirty-guard-test`, page.getByRole("form", { name: "Plan" }));
// Asked of the whole page, or of the element `within` names.
const unsaved = (within?: string) => page.evaluate(selector => (window as unknown as { hasUnsavedInput(root?: Element): boolean })
  .hasUnsavedInput(selector ? document.querySelector(selector)! : undefined), within);

test("a committed value changed by a press elsewhere in its form is unsaved input", async () => {
  await load();
  await page.getByRole("button", { name: "Move everyone" }).click();
  await element(page.locator("[data-form-value]")).toHaveAttribute("data-form-value", "move");
  expect(await unsaved()).toBe(true);
});

test("a press that leaves every control in the form unchanged is not unsaved input", async () => {
  await load();
  await page.getByRole("button", { name: "Preview" }).click();
  expect(await unsaved()).toBe(false);
});

test("a stored draft is unsaved input for the whole page but not for one element, which it has no place in", async () => {
  await load();
  await page.getByRole("button", { name: "Keep a draft" }).click();
  await expect.poll(() => unsaved()).toBe(true);
  expect(await unsaved("main")).toBe(false);
});
