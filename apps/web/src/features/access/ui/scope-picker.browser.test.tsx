// SPDX-License-Identifier: LicenseRef-Proprietary
import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import { afterAll, beforeAll, test } from "vitest";
import { expect as element } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { loadCatalog, t } from "@console/i18n";
import { browserTestOptimizeDeps, chromium, type Browser, type Page } from "../../../lib/browser-test";

const [fixture] = Object.values(import.meta.glob<string>("./scope-picker.browser-fixture.tsx", { query: "?url", import: "default", eager: true }));
const node = (id: string, kind: string, name: string, children: unknown[] = []) => ({ id, kind, name, children, headcount: 3, direct_headcount: 3, dispatched_headcount: 0, chips: [] });
const STRUCTURE = { tenant_name: "Hanbit", phase: "SETUP", unplaced: [], entities: [node("entity", "LEGAL_ENTITY", "Hanbit Foods", [node("seoul", "WORKPLACE", "Seoul office"), node("busan", "WORKPLACE", "Busan plant")])] };
let server: ViteDevServer;
let browser: Browser;
let page: Page;
beforeAll(async () => {
  await loadCatalog("en");
  server = await createServer({ configFile: false, cacheDir: ".cache/scope-picker-test", logLevel: "error",
    optimizeDeps: { ...browserTestOptimizeDeps, entries: ["apps/web/src/features/access/ui/scope-picker.browser-fixture.tsx"] },
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, fs: { allow: [process.cwd(), dirname(realpathSync("node_modules/pretendard"))] } },
  });
  await server.listen();
  browser = await chromium.launch();
  page = await browser.newPage();
  await page.route("**/scope-picker-test*", route => route.fulfill({ contentType: "text/html", body: `<html lang="en"><title>Scope picker</title><div id="root"></div><script type="module" src="${fixture}"></script></html>` }));
  await page.route("**/api/v1/org-structure", route => route.fulfill({ json: STRUCTURE }));
}, 60_000);
afterAll(async () => { await browser?.close(); await server?.close(); });

const row = (name: string) => page.getByRole("row", { name: new RegExp(`^${name} `) });

test("a pick is unsaved input: Escape from the picked row warns first, then closes the scope sheet; with nothing picked it closes at once", async () => {
  const use = () => page.getByRole("button", { name: t("access.scope.done"), exact: true });
  const picks = [
    async () => { await row("Seoul office").click(); await element(use()).toBeEnabled(); },
    async () => { await row("Seoul office").focus(); await page.keyboard.press("Enter"); await element(use()).toBeEnabled(); },
  ];
  const load = async () => {
    await page.goto(`${server.resolvedUrls!.local[0]}scope-picker-test`);
    await element(page.getByRole("treegrid", { name: t("access.scope.tree") })).toBeVisible();
  };
  for (const pick of picks) {
    await load();
    await pick();
    await page.keyboard.press("Escape");
    await element(page.getByRole("status").filter({ hasText: t("composer.unsaved") })).toBeVisible();
    await element(page.locator("#open")).toHaveText("open");
    await page.keyboard.press("Escape");
    await element(page.locator("#open")).toHaveText("closed");
  }
  await load();
  await page.getByRole("button", { name: t("access.cancel"), exact: true }).focus();
  await page.keyboard.press("Escape");
  await element(page.locator("#open")).toHaveText("closed");
});
