// SPDX-License-Identifier: LicenseRef-Proprietary
import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import { afterAll, beforeAll, test } from "vitest";
import { expect as element } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { browserTestOptimizeDeps, chromium, type Browser, type Page } from "../../lib/browser-test";

const [fixture] = Object.values(import.meta.glob<string>("./tree.browser-fixture.tsx", { query: "?url", import: "default", eager: true }));
let server: ViteDevServer;
let browser: Browser;
let page: Page;
beforeAll(async () => {
  server = await createServer({ configFile: false, cacheDir: ".cache/tree-test", logLevel: "error",
    optimizeDeps: { ...browserTestOptimizeDeps, entries: ["apps/web/src/ui/tree/tree.browser-fixture.tsx"] },
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, fs: { allow: [process.cwd(), dirname(realpathSync("node_modules/pretendard"))] } },
  });
  await server.listen();
  browser = await chromium.launch();
  page = await browser.newPage();
  await page.route("**/tree-test*", route => route.fulfill({ contentType: "text/html", body: `<html lang="en"><title>Tree</title><div id="root"></div><script type="module" src="${fixture}"></script></html>` }));
}, 60_000);
afterAll(async () => { await browser?.close(); await server?.close(); });

const open = async (search: string) => {
  await page.goto(`${server.resolvedUrls!.local[0]}tree-test?${search}`);
  await element(page.getByRole("treegrid", { name: "Places" })).toBeVisible();
};
const row = (name: string) => page.getByRole("row", { name, exact: true });
const cancel = () => page.getByRole("button", { name: "Cancel", exact: true });

test("Escape from the chosen row closes the dialog where the caller keeps a row chosen", async () => {
  await open("shape=keep&pick=field");
  await page.keyboard.press("Tab");
  await element(row("Field sales")).toBeFocused();
  await page.keyboard.press("Escape");
  await element(page.locator("#open")).toHaveText("closed");
  await element(page.locator("#picked")).toHaveText("field");
});

test("Escape closes the dialog after a row is chosen by pointer or by Enter", async () => {
  for (const choose of [() => row("Support").click(), async () => { await row("Support").focus(); await page.keyboard.press("Enter"); }]) {
    await open("shape=keep");
    await choose();
    await element(page.locator("#picked")).toHaveText("support");
    await element(row("Support")).toBeFocused();
    await page.keyboard.press("Escape");
    await element(page.locator("#open")).toHaveText("closed");
    await element(page.locator("#picked")).toHaveText("support");
  }
});

test("a tree told to keep a row chosen does not clear it when the row is pressed again", async () => {
  await open("shape=required&pick=support");
  for (const press of [() => row("Support").click(), () => page.keyboard.press("Enter")]) {
    await press();
    await element(row("Support")).toBeFocused();
    await element(page.locator("#picked")).toHaveText("support");
    await element(row("Support")).toHaveAttribute("aria-selected", "true");
  }
});

test("Escape still clears the pick first where the caller takes an empty selection", async () => {
  await open("pick=field");
  await page.keyboard.press("Tab");
  await element(row("Field sales")).toBeFocused();
  await page.keyboard.press("Escape");
  await element(page.locator("#picked")).toHaveText("none");
  await element(page.locator("#open")).toHaveText("open");
  await page.keyboard.press("Escape");
  await element(page.locator("#open")).toHaveText("closed");
});

test("ArrowLeft on a row with no children moves to its parent, though the caller lists it as expanded", async () => {
  await open("shape=keep");
  await row("Field sales").focus();
  await page.keyboard.press("ArrowLeft");
  await element(row("Sales")).toBeFocused();
  await element(row("Field sales")).toBeVisible();
  // A row with children still folds first, then hands the focus up.
  await page.keyboard.press("ArrowLeft");
  await element(row("Sales")).toBeFocused();
  await element(row("Field sales")).toHaveCount(0);
  await page.keyboard.press("ArrowLeft");
  await element(row("North site")).toBeFocused();
});

test.each(["", "&listed=branches"])("ArrowLeft stays on a row with no children whose parent is disabled (shape=keep&off=north%s)", async (listed) => {
  await open(`shape=keep&off=north${listed}`);
  await row("Support").focus();
  await page.keyboard.press("ArrowLeft");
  await element(row("Support")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await element(row("South site")).toBeFocused();
  await page.keyboard.press("Tab");
  await element(cancel()).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await element(row("South site")).toBeFocused();
});

test("ArrowLeft stays on a folded row whose parent is disabled, and the row still unfolds", async () => {
  await open("shape=keep&off=north");
  await row("Field sales").focus();
  await page.keyboard.press("ArrowLeft");
  await element(row("Sales")).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await element(row("Field sales")).toHaveCount(0);
  await page.keyboard.press("ArrowLeft");
  await element(row("Sales")).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await element(row("Field sales")).toBeVisible();
  await element(row("Sales")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await element(row("Field sales")).toBeFocused();
  // Typing a name still finds its row.
  await page.keyboard.type("su");
  await element(row("Support")).toBeFocused();
});

test.each([
  ["shape=keep", "company field north ops south support", "company field north ops sales south support"],
  ["shape=keep&off=north&listed=branches", "company north south", "company north sales south"],
])("folding and unfolding one row changes only that row in the caller's expanded set (%s)", async (search, folded, unfolded) => {
  await open(search);
  await row("Sales").focus();
  await page.keyboard.press("ArrowLeft");
  await element(row("Field sales")).toHaveCount(0);
  await element(page.locator("#expanded")).toHaveText(folded);
  await row("Sales").getByRole("button").click();
  await element(row("Field sales")).toBeVisible();
  await element(page.locator("#expanded")).toHaveText(unfolded);
});

test("an Escape the input method is composing leaves the dialog open from a row, as from the Cancel button", async () => {
  for (const from of [() => row("Field sales"), cancel]) {
    await open("shape=keep&pick=field");
    await from().focus();
    await from().dispatchEvent("keydown", { key: "Escape", isComposing: true, keyCode: 229 });
    await element(page.locator("#open")).toHaveText("open");
    await page.keyboard.press("Escape");
    await element(page.locator("#open")).toHaveText("closed");
  }
});
