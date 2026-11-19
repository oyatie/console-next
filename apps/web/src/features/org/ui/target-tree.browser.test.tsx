// SPDX-License-Identifier: LicenseRef-Proprietary
import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import { afterAll, beforeAll, test } from "vitest";
import { expect as element } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { loadCatalog, t } from "@console/i18n";
import { browserTestOptimizeDeps, chromium, type Browser, type Page } from "../../../lib/browser-test";

const [fixture] = Object.values(import.meta.glob<string>("./target-tree.browser-fixture.tsx", { query: "?url", import: "default", eager: true }));
let server: ViteDevServer;
let browser: Browser;
let page: Page;
beforeAll(async () => {
  await loadCatalog("en");
  server = await createServer({ configFile: false, cacheDir: ".cache/target-tree-test", logLevel: "error",
    optimizeDeps: { ...browserTestOptimizeDeps, entries: ["apps/web/src/features/org/ui/target-tree.browser-fixture.tsx"] },
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, fs: { allow: [process.cwd(), dirname(realpathSync("node_modules/pretendard"))] } },
  });
  await server.listen();
  browser = await chromium.launch();
  page = await browser.newPage();
  await page.route("**/target-tree-test*", route => route.fulfill({ contentType: "text/html", body: `<html lang="en"><title>Target tree</title><div id="root"></div><script type="module" src="${fixture}"></script></html>` }));
}, 60_000);
afterAll(async () => { await browser?.close(); await server?.close(); });

const open = async (search: string) => {
  await page.goto(`${server.resolvedUrls!.local[0]}target-tree-test?${search}`);
  await element(page.getByRole("treegrid")).toBeVisible();
};
const row = (name: string) => page.getByRole("row", { name: new RegExp(`^${name} `) });
const cancel = () => page.getByRole("button", { name: "Cancel", exact: true });
const state = (id: string) => page.locator(`#${id}`);

test("Escape closes the merge sheet from a chosen row, as it does from the Cancel button", async () => {
  for (const choose of [() => row("Support").click(), async () => { await row("Support").focus(); await page.keyboard.press("Enter"); }]) {
    await open("in=sheet");
    await choose();
    await element(state("to")).toHaveText("support");
    await element(row("Support")).toBeFocused();
    await page.keyboard.press("Escape");
    await element(state("open")).toHaveText("closed");
  }
  await open("in=sheet");
  await cancel().focus();
  await page.keyboard.press("Escape");
  await element(state("open")).toHaveText("closed");
});

test.each(["a chosen row", "the Cancel button"])("Escape from %s warns of unsaved input first, then closes the merge sheet", async (from) => {
  await open("in=sheet&dirty=1");
  await row("Support").click();
  if (from !== "a chosen row") await cancel().focus();
  await page.keyboard.press("Escape");
  await element(page.getByRole("status").filter({ hasText: t("composer.unsaved") })).toBeVisible();
  await element(state("open")).toHaveText("open");
  await element(state("to")).toHaveText("support");
  await page.keyboard.press("Escape");
  await element(state("open")).toHaveText("closed");
});

test("the add-departments dialog closes on Escape from a row and on a pick", async () => {
  await open("in=dialog");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await element(row("Sales")).toBeFocused();
  await page.keyboard.press("Escape");
  await element(state("open")).toHaveText("closed");
  await element(state("to")).toHaveText("none");
  await open("in=dialog");
  await row("Packing").click();
  await element(state("open")).toHaveText("closed");
  await element(state("to")).toHaveText("packing");
});

test("ArrowLeft on a department with none under it moves to its parent department", async () => {
  await open("in=sheet");
  await row("Field sales").focus();
  await page.keyboard.press("ArrowLeft");
  await element(row("Sales")).toBeFocused();
  await element(row("Field sales")).toBeVisible();
});

test("ArrowLeft keeps the focus where it is when the parent cannot be chosen", async () => {
  await open("in=sheet");
  await row("Support").focus();
  await page.keyboard.press("ArrowLeft");
  await element(row("Support")).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await element(row("Field sales")).toBeFocused();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await element(row("Field sales")).toBeFocused();
});
