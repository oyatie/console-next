// SPDX-License-Identifier: LicenseRef-Proprietary
import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { expect as element, type Locator } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { browserTestOptimizeDeps, chromium, type Browser, type Page } from "../lib/browser-test";

const [fixture] = Object.values(import.meta.glob<string>("./ime-keys.browser-fixture.tsx", { query: "?url", import: "default", eager: true }));
let server: ViteDevServer;
let browser: Browser;
let page: Page;
beforeAll(async () => {
  server = await createServer({ configFile: false, cacheDir: ".cache/ime-keys-test", logLevel: "error",
    optimizeDeps: { ...browserTestOptimizeDeps, entries: ["apps/web/src/ui/ime-keys.browser-fixture.tsx"] },
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, fs: { allow: [process.cwd(), dirname(realpathSync("node_modules/pretendard"))] } },
  });
  await server.listen();
  browser = await chromium.launch();
  page = await browser.newPage();
  await page.route("**/ime-test*", route => route.fulfill({ contentType: "text/html", body: `<html lang="ko"><title>IME keys</title><div id="root"></div><script type="module" src="${fixture}"></script></html>` }));
}, 60_000);
afterAll(async () => { await browser?.close(); await server?.close(); });

// The two ways a browser marks a key the input method owns: mid-composition, and the Enter that ends a composition
// (reported after compositionend, with only the key code set).
const IME = [{ isComposing: true, keyCode: 13 }, { isComposing: false, keyCode: 229 }];

test.each(IME)("the find box leaves an input-method Enter %j alone, then acts on a plain Enter", async state => {
  await page.goto(`${server.resolvedUrls!.local[0]}ime-test?case=palette`);
  const box = page.getByRole("searchbox", { name: "Find a person" });
  await box.focus();
  await box.dispatchEvent("keydown", { key: "Enter", ...state });
  await box.dispatchEvent("keydown", { key: "ArrowDown", ...state });
  await element(page.locator("#acted")).toHaveText("0");
  await element(box).toBeFocused();
  await box.press("Enter");
  await element(page.locator("#acted")).toHaveText("1");
});

test.each(IME)("the grid editor leaves input-method keys %j alone, then commits on a plain Enter", async state => {
  await page.goto(`${server.resolvedUrls!.local[0]}ime-test?case=grid`);
  const editor = page.getByRole("textbox");
  await element(editor).toBeFocused();
  for (const key of ["Enter", "Tab", "Escape"]) await editor.dispatchEvent("keydown", { key, ...state });
  await element(page.locator("#committed")).toHaveText("0");
  await element(page.locator("#open")).toHaveText("open");
  // Nothing above the editor hears the Escape or the Tab; the grid sees the Enter and must leave what was typed alone.
  await element(page.locator("#above")).toHaveText("0");
  await element(editor).toHaveValue("8");
  await element(editor).toBeFocused();
  await editor.press("Enter");
  await element(page.locator("#committed")).toHaveText("1");
});

// An Escape or Tab pressed while a syllable is composing: marked as composing, or, where the browser ends the
// composition before the keydown, by the key code alone.
const COMPOSING = [{ isComposing: true }, { isComposing: false, keyCode: 229 }];
const open = (which: string) => page.goto(`${server.resolvedUrls!.local[0]}ime-test?case=${which}`);
/** Sends the keydown; true when nothing cancelled the browser's own action for it. */
const send = (target: Locator, init: { key: string; isComposing: boolean; keyCode?: number }) =>
  target.evaluate((el, i) => el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...i })), init);

const ENTRIES = [{ which: "field", value: "ab", caller: true }, { which: "area", value: "ab", caller: true }, { which: "masked", value: "12", caller: false }, { which: "reason", value: "ab", caller: false }];
test.each(ENTRIES.flatMap(entry => ["Escape", "Tab"].flatMap(key => COMPOSING.map(state => ({ ...entry, key, state })))))(
  "$which: $key while composing $state reaches no handler, and the next $key acts", async ({ which, value, caller, key, state }) => {
    await open(which);
    const box = page.getByRole("textbox");
    await box.focus();
    // The Tab's own action stays with the browser, which commits the syllable and moves on; the Escape's is cancelled.
    expect(await send(box, { key, ...state })).toBe(key === "Tab");
    await element(page.locator("#heard")).toHaveText("");
    await element(box).toHaveValue(value);
    // A dispatched event carries no default action, so this shows only that no handler moved focus.
    await element(box).toBeFocused();
    await box.press(key);
    await element(page.locator("#heard")).toHaveText(caller ? "native caller above window" : "native above window");
  });

test("a real Escape and Tab while Chromium composes a syllable reach no handler; the Tab commits the syllable and moves on", async () => {
  await open("field");
  const box = page.getByRole("textbox");
  await box.press("End");
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.imeSetComposition", { text: "c", selectionStart: 1, selectionEnd: 1 });
  await page.keyboard.press("Escape");
  await page.keyboard.press("Tab");
  await element(page.getByRole("button", { name: "Next" })).toBeFocused();
  await element(box).toHaveValue("abc");
  await element(page.locator("#heard")).toHaveText("");
});

test("a real Escape while Chromium composes a syllable in a search box does not clear the box", async () => {
  await open("search");
  const box = page.getByRole("searchbox");
  await box.press("End");
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.imeSetComposition", { text: "c", selectionStart: 1, selectionEnd: 1 });
  await page.keyboard.press("Escape");
  await element(box).toHaveValue("abc");
  await element(page.locator("#heard")).toHaveText("");
});

// Each acts on Escape through a listener of its own, above a bare input that cannot guard the key for it.
const closedOnce = () => page.locator("#closed", { hasText: "1" });
const ACTED: Record<string, () => Locator> = {
  sheet: () => page.getByRole("dialog").getByRole("status"),
  dirty: () => page.locator("#armed", { hasText: "true" }),
  panel: closedOnce,
  actions: closedOnce,
  card: () => page.getByRole("button", { name: "Approve it" }),
};
test.each(Object.keys(ACTED).flatMap(which => COMPOSING.map(state => ({ which, state }))))(
  "$which leaves an Escape pressed while composing $state alone, then acts on a plain Escape", async ({ which, state }) => {
    await open(which);
    if (which === "card") await page.getByRole("button", { name: /reject$/i }).click();
    const raw = page.getByRole("textbox", { name: "Raw" });
    await raw.focus();
    await send(raw, { key: "Escape", ...state });
    await element(ACTED[which]!()).toHaveCount(0);
    await element(raw).toBeFocused();
    await raw.press("Escape");
    await element(ACTED[which]!()).toHaveCount(1);
  });

test.each(COMPOSING)("the find box stays open through an Escape pressed while composing %j, then closes on a plain Escape", async state => {
  await open("palette");
  const box = page.getByRole("searchbox", { name: "Find a person" });
  await box.focus();
  await send(box, { key: "Escape", ...state });
  await element(page.locator("#closed")).toHaveText("0");
  await box.press("Escape");
  await element(page.locator("#closed")).toHaveText("1");
});

test.each(COMPOSING)("the key map's filter keeps what was typed through an Escape pressed while composing %j, then clears on a plain Escape", async state => {
  await open("keymap");
  const box = page.getByRole("searchbox", { name: "Filter" });
  await box.fill("ab");
  await send(box, { key: "Escape", ...state });
  await element(box).toHaveValue("ab");
  await element(page.locator("#closed")).toHaveText("0");
  await box.press("Escape");
  await element(box).toHaveValue("");
});
