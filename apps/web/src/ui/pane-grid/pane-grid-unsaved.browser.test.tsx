// SPDX-License-Identifier: LicenseRef-Proprietary
import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import { afterAll, beforeAll, test } from "vitest";
import { expect as element } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { loadCatalog, t } from "@console/i18n";
import { browserTestOptimizeDeps, chromium, openBrowserTestPage, type Browser, type Page } from "../../lib/browser-test";

const [fixture] = Object.values(import.meta.glob<string>("./pane-grid-unsaved.browser-fixture.tsx", { query: "?url", import: "default", eager: true }));
let server: ViteDevServer;
let browser: Browser;
let page: Page;
beforeAll(async () => {
  await loadCatalog("ko");
  server = await createServer({ configFile: false, cacheDir: ".cache/pane-grid-unsaved-test", logLevel: "error",
    optimizeDeps: { ...browserTestOptimizeDeps, entries: ["apps/web/src/ui/pane-grid/pane-grid-unsaved.browser-fixture.tsx"] },
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, fs: { allow: [process.cwd(), dirname(realpathSync("node_modules/pretendard"))] } },
  });
  await server.listen();
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.route("**/pane-grid-unsaved-test", route => route.fulfill({ contentType: "text/html", body: `<html lang="ko"><title>Pane grid</title><div id="root"></div><script type="module" src="${fixture}"></script></html>` }));
}, 60_000);
afterAll(async () => { await browser?.close(); await server?.close(); });

const row = () => page.getByRole("button", { name: "Row A", exact: true });
const warning = () => page.getByRole("status").filter({ hasText: t("composer.unsaved") });
const openRecord = async () => {
  await openBrowserTestPage(page, `${server.resolvedUrls!.local[0]}pane-grid-unsaved-test`, row());
  await row().click();
  const pane = page.getByRole("complementary", { name: "Record", exact: true });
  await pane.getByRole("textbox", { name: "Note text" }).fill("Half a sentence");
  return pane;
};

for (const from of ["a button in the form", "the list row"]) {
  test(`Escape from ${from} warns before the record pane drops typed input, and a second Escape closes it`, async () => {
    const pane = await openRecord();
    const control = from === "the list row" ? row() : pane.getByRole("button", { name: "Check spelling" });
    await control.focus();
    await page.keyboard.press("Escape");
    await element(pane.getByRole("textbox", { name: "Note text" })).toHaveValue("Half a sentence");
    await element(warning()).toBeVisible();
    await element(control).toBeFocused();
    await page.keyboard.press("Escape");
    await element(pane).toHaveCount(0);
    await element(row()).toBeFocused();
  });
}

test("a save the screen refuses leaves the typed input unsaved, so Escape still warns", async () => {
  const pane = await openRecord();
  const save = pane.getByRole("button", { name: "Save" });
  await save.click();
  await save.press("Escape");
  await element(warning()).toBeVisible();
  await element(pane.getByRole("textbox", { name: "Note text" })).toHaveValue("Half a sentence");
});

test("a click that changes a value after the warning withdraws it, so the next Escape warns again", async () => {
  const pane = await openRecord();
  const spelling = pane.getByRole("button", { name: "Check spelling" });
  await spelling.press("Escape");
  await element(warning()).toBeVisible();
  await pane.getByRole("checkbox", { name: "Urgent" }).click();
  await element(warning()).toHaveCount(0);
  await spelling.press("Escape");
  await element(warning()).toBeVisible();
  await element(pane.getByRole("checkbox", { name: "Urgent" })).toBeChecked();
});

test("Escape closes a clean related pane at once over a record pane with typed input, which still warns", async () => {
  const pane = await openRecord();
  await pane.getByRole("button", { name: "Open related" }).click();
  const related = page.getByRole("complementary", { name: "Related", exact: true });
  await related.getByRole("button", { name: "Related action" }).press("Escape");
  await element(related).toHaveCount(0);
  await element(warning()).toHaveCount(0);
  await element(pane.getByRole("textbox", { name: "Note text" })).toHaveValue("Half a sentence");
  await pane.getByRole("button", { name: "Check spelling" }).press("Escape");
  await element(warning()).toBeVisible();
});

test("Escape from a button in an untouched form closes the record pane at once", async () => {
  await openBrowserTestPage(page, `${server.resolvedUrls!.local[0]}pane-grid-unsaved-test`, row());
  await row().click();
  const pane = page.getByRole("complementary", { name: "Record", exact: true });
  await pane.getByRole("textbox", { name: "Note text" }).focus();
  await pane.getByRole("button", { name: "Check spelling" }).press("Escape");
  await element(pane).toHaveCount(0);
});
