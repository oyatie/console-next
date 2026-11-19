// SPDX-License-Identifier: LicenseRef-Proprietary
import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import { afterAll, beforeAll, test } from "vitest";
import { expect as element } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { browserTestOptimizeDeps, chromium, type Browser, type Page } from "../../../lib/browser-test";

const [fixture] = Object.values(import.meta.glob<string>("./close-target-picker.browser-fixture.tsx", { query: "?url", import: "default", eager: true }));
let server: ViteDevServer;
let browser: Browser;
let page: Page;
beforeAll(async () => {
  server = await createServer({ configFile: false, cacheDir: ".cache/close-target-picker-test", logLevel: "error",
    optimizeDeps: { ...browserTestOptimizeDeps, entries: ["apps/web/src/features/entity/ui/close-target-picker.browser-fixture.tsx"] },
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, fs: { allow: [process.cwd(), dirname(realpathSync("node_modules/pretendard"))] } },
  });
  await server.listen();
  browser = await chromium.launch();
  page = await browser.newPage();
  await page.route("**/close-target-test*", route => route.fulfill({ contentType: "text/html", body: `<html lang="en"><title>Close target</title><div id="root"></div><script type="module" src="${fixture}"></script></html>` }));
}, 60_000);
afterAll(async () => { await browser?.close(); await server?.close(); });

const opener = () => page.getByRole("button", { name: "Destination of Packing" });
const row = (name: string) => page.getByRole("row", { name: new RegExp(`^${name} `) });
const openPicker = async () => {
  await page.goto(`${server.resolvedUrls!.local[0]}close-target-test`);
  await opener().click();
  await element(page.getByRole("dialog")).toBeVisible();
};

test("Escape from the tree closes the destination picker once a destination is chosen", async () => {
  await openPicker();
  await row("Support").click();
  await element(page.getByRole("dialog")).toHaveCount(0);
  await element(opener()).toHaveText("Seoul office › Support");
  await opener().click();
  await page.keyboard.press("Tab");
  await element(row("Support")).toBeFocused();
  await page.keyboard.press("Escape");
  await element(page.getByRole("dialog")).toHaveCount(0);
  await element(opener()).toBeFocused();
  await element(opener()).toHaveText("Seoul office › Support");
});
