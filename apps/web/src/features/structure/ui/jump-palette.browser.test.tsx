// SPDX-License-Identifier: LicenseRef-Proprietary
import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { expect as element } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { loadCatalog, t } from "@console/i18n";
import { browserTestOptimizeDeps, chromium, type Browser, type Page } from "../../../lib/browser-test";
import { employees, id, structure } from "../../../../../../e2e/mock/fixtures";

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
const row = (name: string | RegExp) => palette().getByRole("menuitem", { name });
/** Where the palette sent the person. */
const at = () => page.getByRole("status", { name: "Location" });
/** Waits until the box names the row as its active one: the row is highlighted and Enter acts on it. */
const lit = async (name: string | RegExp) => element(box()).toHaveAttribute("aria-activedescendant", (await row(name).getAttribute("id"))!);
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

test("Enter opens the person the search found, not the standing import task, when the answers land between keystrokes", async () => {
  await open("chord");
  found = q => [`Kim ${q}`, `Kimura ${q}`];
  await page.keyboard.type("k");
  await element(row(/^Kim k/)).toBeVisible();
  await page.keyboard.type("i");
  await lit(/^Kim ki/);
  await page.keyboard.press("Enter");
  await element(at()).toHaveText(`/people/${id(100)}`);
  await element(palette()).toHaveCount(0);
});

test("typing that outruns the server still ends on the first person, and the arrows move from there", async () => {
  await open("chord");
  found = q => [`Kim ${q}`, `Kimura ${q}`];
  let land = () => {};
  landed = new Promise(done => { land = done; });
  await page.keyboard.type("kim");
  await element(row(t("structure.import.label"))).toBeVisible();
  land();
  await lit(/^Kim kim/);
  await page.keyboard.press("ArrowDown");
  await lit(/^Kimura kim/);
  await page.keyboard.press("Enter");
  await element(at()).toHaveText(`/people/${id(101)}`);
});

test("a row chosen with the keys keeps the highlight when late people land above it", async () => {
  await open("chord");
  found = q => [`Kim ${q}`];
  let land = () => {};
  landed = new Promise(done => { land = done; });
  // Long enough to be a request key too: two rows stand before the people answer, the request lookup and the import.
  await page.keyboard.type("kim-request-key-0001");
  await lit(t("requestOutcome.find"));
  await page.keyboard.press("End");
  await lit(t("structure.import.label"));
  land();
  await element(row(/^Kim kim/)).toBeVisible();
  await page.keyboard.press("Enter");
  await element(at()).toHaveText("/org#structure-import");
});

test("Enter pressed before the people answer waits for them, and does not open the standing import task", async () => {
  await open("chord");
  found = q => [`Kim ${q}`];
  let land = () => {};
  landed = new Promise(done => { land = done; });
  const asked = page.waitForRequest(request => new URL(request.url()).searchParams.get("search") === "kim");
  await page.keyboard.type("kim");
  await asked;
  await element(row(t("structure.import.label"))).toBeVisible();
  // The palette says the search is out, which is why the Enter that follows opens nothing yet.
  await element(palette().getByRole("status")).toHaveText(t("uiCommandPalette.searching"));
  await page.keyboard.press("Enter");
  land();
  // Still open, at the same place, with the person the search found now taking Enter.
  await element(row(/^Kim kim/)).toBeVisible();
  await lit(/^Kim kim/);
  await element(palette().getByRole("status")).toHaveText("");
  await element(at()).toHaveText("/");
  await page.keyboard.press("Enter");
  await element(at()).toHaveText(`/people/${id(100)}`);
});

test("Enter opens a place the search found without waiting for the people, who land below it", async () => {
  await open("chord");
  let land = () => {};
  landed = new Promise(done => { land = done; });
  const site = structure(1).entities[0]!.children[0]!;
  const asked = page.waitForRequest(request => new URL(request.url()).searchParams.get("search") === site.name);
  await page.keyboard.type(site.name);
  await asked;
  // The place is the first row; the tasks for it, further down, carry its name too.
  await element(box()).toHaveAttribute("aria-activedescendant", (await row(site.name).first().getAttribute("id"))!);
  await page.keyboard.press("Enter");
  await element(at()).toHaveText(new RegExp(`^/org\\?.*sel=${site.id}`));
  land();
});

test.each(["a caret move", "a click in the box"] as const)("Enter still opens the first result after %s", async how => {
  await open("chord");
  found = q => [`Kim ${q}`, `Kimura ${q}`];
  await page.keyboard.type("kim");
  await lit(/^Kim kim/);
  if (how === "a caret move") await page.keyboard.press("ArrowLeft");
  else await box().click();
  await page.keyboard.press("Enter");
  await element(at()).toHaveText(`/people/${id(100)}`);
  await element(palette()).toHaveCount(0);
});

test("emptied with Escape, the box highlights no standing task and Enter opens none", async () => {
  await open("chord");
  found = q => [`Kim ${q}`];
  await page.keyboard.type("kim");
  await lit(/^Kim kim/);
  await page.keyboard.press("Escape");
  await element(box()).toHaveValue("");
  await element(palette().locator("[role=menuitem][data-focused]")).toHaveCount(0);
  await page.keyboard.press("Enter");
  // The palette is still open where it was: it takes the next search.
  await page.keyboard.type("kim");
  await lit(/^Kim kim/);
  await element(at()).toHaveText("/");
});

test("a click on a row below the highlighted one opens that row", async () => {
  await open("button");
  found = q => [`Kim ${q}`, `Kimura ${q}`];
  await page.keyboard.type("kim");
  await lit(/^Kim kim/);
  await row(/^Kimura kim/).click();
  await element(at()).toHaveText(`/people/${id(101)}`);
  await element(palette()).toHaveCount(0);
});

test("a name typed through an input method keeps its composition, and only a plain Enter opens the first person", async () => {
  await open("chord");
  found = q => [`Kim ${q}`];
  const ime = await page.context().newCDPSession(page);
  // The composition grows a letter at a time, as a syllable does, and each answer lands before the next letter.
  for (const text of ["k", "ki", "kim"]) {
    await ime.send("Input.imeSetComposition", { text, selectionStart: text.length, selectionEnd: text.length });
    await lit(new RegExp(`^Kim ${text}$`));
  }
  // Still one composition: a broken one would have kept its letters and started again after them.
  await element(box()).toHaveValue("kim");
  // The two ways a browser marks an Enter the input method owns: mid-composition, and the one that ends a composition.
  for (const state of [{ isComposing: true }, { isComposing: false, keyCode: 229 }]) await box().dispatchEvent("keydown", { key: "Enter", ...state });
  await ime.send("Input.insertText", { text: "kim" });
  await element(box()).toHaveValue("kim");
  await element(at()).toHaveText("/");
  await page.keyboard.press("Enter");
  await element(at()).toHaveText(`/people/${id(100)}`);
});

const KEY = "request-key-0001";
test("a pasted request key is opened by Enter", async () => {
  await open("chord");
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.evaluate(key => navigator.clipboard.writeText(key), KEY);
  await element(box()).toBeFocused();
  await box().evaluate(input => {
    input.addEventListener("beforeinput", event => {
      input.setAttribute("data-paste-type", (event as InputEvent).inputType);
    }, { once: true });
  });
  await page.keyboard.press("ControlOrMeta+V");
  await element(box()).toHaveValue(KEY);
  await element(box()).toHaveAttribute("data-paste-type", "insertFromPaste");
  await lit(t("requestOutcome.find"));
  await page.keyboard.press("Enter");
  await element(at()).toHaveText(`/requests/${KEY}`);
});

test("Enter still acts after a character is deleted", async () => {
  await open("chord");
  await page.keyboard.type(`${KEY}2`);
  await element(row(t("requestOutcome.find"))).toContainText(`${KEY}2`);
  await page.keyboard.press("Backspace");
  await element(row(t("requestOutcome.find"))).not.toContainText(`${KEY}2`);
  await lit(t("requestOutcome.find"));
  await page.keyboard.press("Enter");
  await element(at()).toHaveText(`/requests/${KEY}`);
});

test("a letter typed and deleted while the page is busy leaves Enter on the first result", async () => {
  await open("chord");
  await page.keyboard.type(KEY);
  await lit(t("requestOutcome.find"));
  // Both keys wait for the page to free up, then land back to back, before the list is drawn for the first of them.
  const busy = page.evaluate(() => { for (const end = performance.now() + 400; performance.now() < end;); });
  await Promise.all([page.keyboard.press("2"), page.keyboard.press("Backspace"), busy]);
  await element(box()).toHaveValue(KEY);
  await lit(t("requestOutcome.find"));
  await page.keyboard.press("Enter");
  await element(at()).toHaveText(`/requests/${KEY}`);
});
