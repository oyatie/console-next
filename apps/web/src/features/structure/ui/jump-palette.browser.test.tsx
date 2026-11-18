// SPDX-License-Identifier: LicenseRef-Proprietary
import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import { afterAll, beforeAll, test } from "vitest";
import { expect as element } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { loadCatalog, t } from "@console/i18n";
import { browserTestOptimizeDeps, chromium, type Browser, type Page } from "../../../lib/browser-test";
import { employees, structure } from "../../../../../../e2e/mock/fixtures";

const [fixture] = Object.values(import.meta.glob<string>("./jump-palette.browser-fixture.tsx", { query: "?url", import: "default", eager: true }));
let server: ViteDevServer;
let browser: Browser;
let page: Page;
/** The people the server finds for a search, answered once `landed` lets them through. */
let found: (search: string) => string[] = () => [];
let landed: Promise<void> = Promise.resolve();
beforeAll(async () => {
  await loadCatalog("ko");
  server = await createServer({ configFile: false, cacheDir: ".cache/jump-palette-test", logLevel: "error",
    optimizeDeps: { ...browserTestOptimizeDeps, entries: ["apps/web/src/features/structure/ui/jump-palette.browser-fixture.tsx"] },
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, fs: { allow: [process.cwd(), dirname(realpathSync("node_modules/pretendard"))] } },
  });
  await server.listen();
  browser = await chromium.launch();
  page = await browser.newPage();
  await page.route("**/jump-palette-test*", route => route.fulfill({ contentType: "text/html", body: `<html lang="ko"><title>Jump palette</title><div id="root"></div><script type="module" src="${fixture}"></script></html>` }));
  await page.route("**/api/v1/org-structure", route => route.fulfill({ json: structure(1) }));
  await page.route("**/api/v1/legal-entities", route => route.fulfill({ json: { items: [] } }));
  await page.route("**/api/v1/workplace-kinds", route => route.fulfill({ json: { items: [] } }));
  await page.route("**/api/v1/employees?*", async route => {
    const names = found(new URL(route.request().url()).searchParams.get("search") ?? "");
    await landed;
    await route.fulfill({ json: { items: employees(names.length).map((p, i) => ({ ...p, name: names[i] })), total: names.length, limit: 5, offset: 0, next_cursor: null } });
  });
}, 60_000);
afterAll(async () => { await browser?.close(); await server?.close(); });

const palette = () => page.getByRole("dialog", { name: t("shell.jumpLabel"), exact: true });
const box = () => palette().getByRole("searchbox");
const search = () => page.getByRole("button", { name: "Search" });
/** Opens the palette the two ways the shell does, without touching the search box. */
const open = async (how: "chord" | "button") => {
  found = () => [];
  landed = Promise.resolve();
  await page.goto(`${server.resolvedUrls!.local[0]}jump-palette-test`);
  await element(page.getByText("Jump palette fixture")).toBeVisible();
  if (how === "chord") await page.keyboard.press("ControlOrMeta+KeyK");
  else await search().click();
  await element(palette()).toBeVisible();
};

test.each(["chord", "button"] as const)("opened by the %s, the palette takes what is typed without a click or a Tab", async how => {
  await open(how);
  await page.keyboard.type("kim");
  await element(box()).toHaveValue("kim");
  await element(box()).toBeFocused();
  // The first Escape clears the box, the second closes; focus returns to where the person was.
  await page.keyboard.press("Escape");
  await element(box()).toHaveValue("");
  await page.keyboard.press("Escape");
  await element(palette()).toHaveCount(0);
  if (how === "button") await element(search()).toBeFocused();
});
