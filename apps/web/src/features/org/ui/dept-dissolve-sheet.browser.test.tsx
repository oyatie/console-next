// SPDX-License-Identifier: LicenseRef-Proprietary
import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import { afterAll, beforeAll, test } from "vitest";
import { expect as element } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { loadCatalog, t } from "@console/i18n";
import { browserTestOptimizeDeps, chromium, type Browser, type Page } from "../../../lib/browser-test";

const [fixture] = Object.values(import.meta.glob<string>("./dept-dissolve-sheet.browser-fixture.tsx", { query: "?url", import: "default", eager: true }));
let server: ViteDevServer;
let browser: Browser;
let page: Page;
beforeAll(async () => {
  await loadCatalog("en");
  server = await createServer({ configFile: false, cacheDir: ".cache/dept-dissolve-test", logLevel: "error",
    optimizeDeps: { ...browserTestOptimizeDeps, entries: ["apps/web/src/features/org/ui/dept-dissolve-sheet.browser-fixture.tsx"] },
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, fs: { allow: [process.cwd(), dirname(realpathSync("node_modules/pretendard"))] } },
  });
  await server.listen();
  browser = await chromium.launch();
  page = await browser.newPage();
  await page.route("**/dept-dissolve-test*", route => route.fulfill({ contentType: "text/html", body: `<html lang="en"><title>Dissolve</title><div id="root"></div><script type="module" src="${fixture}"></script></html>` }));
  await page.route("**/api/v1/org-units/packing", route => route.fulfill({ json: { members: { items: [{ employeeId: "kim", name: "Kim Mina" }, { employeeId: "lee", name: "Lee Jun" }] } } }));
  await page.route("**/api/v1/access/grants", route => route.fulfill({ json: [] }));
  await page.route("**/api/v1/settings", route => route.fulfill({ json: { items: [] } }));
}, 60_000);
afterAll(async () => { await browser?.close(); await server?.close(); });

const group = (to: string, count: number) => page.getByRole("region", { name: t("orgUnit.dissolve.group", { to, count }), exact: true });
const row = (name: string) => page.getByRole("row", { name: new RegExp(`^${name} `) });
const unsaved = () => page.getByRole("status").filter({ hasText: t("composer.unsaved") });
const open = () => page.locator("#open");
const load = async () => {
  await page.goto(`${server.resolvedUrls!.local[0]}dept-dissolve-test`);
  await element(group("Seoul office › Operations", 2)).toBeVisible();
};
const button = (name: string) => page.getByRole("button", { name, exact: true });
// A pressed button that goes away, such as "Same as everyone", leaves focus on the page, where Escape reaches no sheet.
const pressEscape = async () => {
  await button(t("orgUnit.dissolve.changeTo")).focus();
  await page.keyboard.press("Escape");
};

test("Escape closes the dissolve sheet when no one has changed where the members go", async () => {
  await load();
  await pressEscape();
  await element(open()).toHaveText("closed");
});

test.each([
  ["a new destination for everyone", async () => {
    await button(t("orgUnit.dissolve.changeTo")).click();
    await row("Support").click();
    await element(group("Seoul office › Support", 2)).toBeVisible();
  }],
  ["one person sent elsewhere", async () => {
    await button(t("orgUnit.dissolve.elsewhere", { name: "Kim Mina" })).click();
    await row("Support").click();
    await element(group("Seoul office › Support", 1)).toBeVisible();
  }],
])("%s is unsaved once the tree closes: Escape warns first, then closes the dissolve sheet", async (_, change) => {
  await load();
  await change();
  await element(page.getByRole("treegrid")).toHaveCount(0);
  await pressEscape();
  await element(unsaved()).toBeVisible();
  await element(open()).toHaveText("open");
  await pressEscape();
  await element(open()).toHaveText("closed");
});

test("a person sent elsewhere stays unsaved while another person's tree is open", async () => {
  await load();
  await button(t("orgUnit.dissolve.elsewhere", { name: "Kim Mina" })).click();
  await row("Support").click();
  await button(t("orgUnit.dissolve.elsewhere", { name: "Lee Jun" })).click();
  await element(page.getByRole("treegrid")).toHaveCount(1);
  await pressEscape();
  await element(unsaved()).toBeVisible();
  await element(open()).toHaveText("open");
});

test.each([
  ["a person put back with everyone", async () => {
    await button(t("orgUnit.dissolve.elsewhere", { name: "Kim Mina" })).click();
    await row("Support").click();
    await button(t("orgUnit.dissolve.backToAll")).click();
  }],
  ["everyone sent back to where one person was sent", async () => {
    await button(t("orgUnit.dissolve.changeTo")).click();
    await row("Support").click();
    await button(t("orgUnit.dissolve.elsewhere", { name: "Kim Mina" })).click();
    await row("Operations").click();
    await button(t("orgUnit.dissolve.changeTo")).click();
    await row("Operations").click();
  }],
])("%s leaves nothing unsaved, so Escape closes the dissolve sheet", async (_, change) => {
  await load();
  await change();
  await element(group("Seoul office › Operations", 2)).toBeVisible();
  await pressEscape();
  await element(open()).toHaveText("closed");
});
