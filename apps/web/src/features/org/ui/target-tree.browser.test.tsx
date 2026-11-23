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

test("Escape closes a merge sheet with nothing chosen, from a row and from the Cancel button", async () => {
  for (const from of [() => row("Support").focus(), () => cancel().focus()]) {
    await open("in=sheet");
    await from();
    await page.keyboard.press("Escape");
    await element(state("open")).toHaveText("closed");
    await element(state("to")).toHaveText("none");
  }
});

test("a pick alone is unsaved input: Escape from the chosen row warns first, then closes the merge sheet", async () => {
  for (const choose of [() => row("Support").click(), async () => { await row("Support").focus(); await page.keyboard.press("Enter"); }]) {
    await open("in=sheet");
    await choose();
    await element(state("to")).toHaveText("support");
    await element(row("Support")).toBeFocused();
    await page.keyboard.press("Escape");
    await element(page.getByRole("status").filter({ hasText: t("composer.unsaved") })).toBeVisible();
    await element(state("open")).toHaveText("open");
    await page.keyboard.press("Escape");
    await element(state("open")).toHaveText("closed");
  }
});

test("an expanded disclosure button opens no popup, so Escape from it warns of unsaved input, then closes the sheet", async () => {
  await open("in=sheet&dirty=1");
  const details = page.getByRole("button", { name: "Details", exact: true });
  await details.focus();
  await page.keyboard.press("Enter");
  await element(details).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Escape");
  await element(page.getByRole("status").filter({ hasText: t("composer.unsaved") })).toBeVisible();
  await element(state("open")).toHaveText("open");
  await page.keyboard.press("Escape");
  await element(state("open")).toHaveText("closed");
});

test.each([
  ["a chosen row with none under it", "Support"],
  ["a chosen row with its departments shown", "Sales"],
  ["the Cancel button", "Support"],
])("Escape from %s warns of unsaved input first, then closes the merge sheet", async (from, name) => {
  await open("in=sheet&dirty=1");
  await row(name).click();
  if (from === "the Cancel button") await cancel().focus();
  else await element(row(name)).toBeFocused();
  if (name === "Sales") await element(row(name)).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Escape");
  await element(page.getByRole("status").filter({ hasText: t("composer.unsaved") })).toBeVisible();
  await element(state("open")).toHaveText("open");
  await element(state("to")).toHaveText(name.toLowerCase());
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
  // A department folded away under its workplace stays focused as well.
  await row("Sales").focus();
  await page.keyboard.press("ArrowLeft");
  await element(row("Field sales")).toHaveCount(0);
  await page.keyboard.press("ArrowLeft");
  await element(row("Sales")).toBeFocused();
});
