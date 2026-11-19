// SPDX-License-Identifier: LicenseRef-Proprietary
import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { expect as element } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { browserTestOptimizeDeps, chromium, type Browser, type Page } from "../../lib/browser-test";

const [fixture] = Object.values(import.meta.glob<string>("./month-grid.browser-fixture.tsx", { query: "?url", import: "default", eager: true }));
let server: ViteDevServer;
let browser: Browser;
let page: Page;
beforeAll(async () => {
  server = await createServer({ configFile: false, cacheDir: ".cache/month-grid-test", logLevel: "error",
    optimizeDeps: { ...browserTestOptimizeDeps, entries: ["apps/web/src/ui/month-grid/month-grid.browser-fixture.tsx"] },
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, fs: { allow: [process.cwd(), dirname(realpathSync("node_modules/pretendard"))] } },
  });
  await server.listen();
  browser = await chromium.launch();
  page = await browser.newPage();
  await page.route("**/month-test*", route => route.fulfill({ contentType: "text/html", body: `<html lang="en"><title>Month grid</title><div id="root"></div><script type="module" src="${fixture}"></script></html>` }));
}, 60_000);
afterAll(async () => { await browser?.close(); await server?.close(); });

// October 2026 is drawn in five weeks, from Sunday 27 September to Saturday 31 October. Its first day is a Thursday.
const open = async (query = "", size = { width: 1280, height: 720 }) => {
  await page.setViewportSize(size);
  await page.goto(`${server.resolvedUrls!.local[0]}month-test${query}`);
  await element(page.getByRole("grid", { name: "October 2026" })).toBeVisible();
};
const day = (date: string) => page.getByRole("gridcell").and(page.locator(`[data-date="${date}"]`));
/** Focus is on that day, and it is the grid's one tab stop. */
const on = (date: string) => expect.poll(() => page.evaluate(() => ({
  focus: document.activeElement instanceof HTMLElement ? document.activeElement.dataset.date : undefined,
  stops: [...document.querySelectorAll<HTMLElement>('td[tabindex="0"]')].map(el => el.dataset.date),
}))).toEqual({ focus: date, stops: [date] });
/** The last key pressed, and whether the grid cancelled its default ("taken") or not ("left"). */
const key = (text: string) => element(page.locator("#key")).toHaveText(text);
const press = async (...keys: string[]) => { for (const k of keys) await page.keyboard.press(k); };
// A viewport shorter than the fixture, so the page has room to scroll both ways from 40.
const SHORT = { width: 390, height: 420 };
const scrollPart = () => page.evaluate(() => scrollTo(0, 40));
/** Where the page is scrolled to, read two frames on so that a scroll the last key started has moved it. */
const scrolled = () => page.evaluate(() => new Promise<number>(done => requestAnimationFrame(() => requestAnimationFrame(() => done(scrollY)))));
const tabIn = async () => {
  await page.getByRole("button", { name: "Before" }).focus();
  await press("Tab");
  await on("2026-10-01");
};

test("Up in the first week stays on the day, from the tab stop and from a day that was clicked, and does not scroll the page", async () => {
  await open("", SHORT);
  await tabIn();
  await scrollPart();
  await press("ArrowUp");
  await on("2026-10-01");
  await key("ArrowUp taken");
  expect(await scrolled()).toBe(40);
  await day("2026-09-29").click();
  await on("2026-09-29");
  await press("ArrowUp");
  await on("2026-09-29");
});

test("Down in the last week stays on the day, reached by arrows and by a click, and does not scroll the page", async () => {
  await open("", SHORT);
  await tabIn();
  await press("ArrowDown", "ArrowDown", "ArrowDown", "ArrowDown");
  await on("2026-10-29");
  await scrollPart();
  await press("ArrowDown");
  await on("2026-10-29");
  await key("ArrowDown taken");
  expect(await scrolled()).toBe(40);
  await day("2026-10-26").click();
  await on("2026-10-26");
  await press("ArrowDown");
  await on("2026-10-26");
});

test("the other keys move as the design page says: a week up or down, across a week's end, to a week's ends, and no further than the days shown", async () => {
  await open();
  await tabIn();
  await press("ArrowDown");
  await on("2026-10-08");
  await press("ArrowUp");
  await on("2026-10-01");
  await press("End");
  await on("2026-10-03");
  await press("ArrowRight");
  await on("2026-10-04");
  await press("ArrowLeft");
  await on("2026-10-03");
  await press("Home");
  await on("2026-09-27");
  await press("ArrowLeft");
  await on("2026-09-27");
  await key("ArrowLeft taken");
  await day("2026-10-31").click();
  await press("ArrowRight");
  await on("2026-10-31");
  await key("ArrowRight taken");
  await press("Home");
  await on("2026-10-25");
  await press("End");
  await on("2026-10-31");
  // A modifier is not read: the key moves the same way.
  await press("Shift+ArrowUp");
  await on("2026-10-24");
  await press("Control+Home");
  await on("2026-10-18");
});

test("a key the grid has no use for is left to the browser: Page Up and Page Down, a letter, and with nothing to choose Enter and Space", async () => {
  await open();
  await tabIn();
  for (const k of ["PageUp", "PageDown", "KeyA", "Enter", "Space"]) {
    await press(k);
    await key(`${k} left`);
    await on("2026-10-01");
  }
  // Tab leaves the grid in one step each way, and comes back to the day last focused.
  await press("ArrowRight", "Tab");
  await element(page.getByRole("button", { name: "After" })).toBeFocused();
  await press("Shift+Tab");
  await on("2026-10-02");
  await press("Shift+Tab");
  await element(page.getByRole("button", { name: "Before" })).toBeFocused();
});

test("with a day to choose, Enter, Space and a click choose the focused day", async () => {
  await open("?choose");
  await tabIn();
  await press("ArrowRight", "Enter");
  await key("Enter taken");
  await element(page.locator("#chosen")).toHaveText("2026-10-02");
  await element(day("2026-10-02")).toHaveAttribute("aria-selected", "true");
  await press("ArrowRight", "Space");
  await key("Space taken");
  await element(page.locator("#chosen")).toHaveText("2026-10-03");
  await day("2026-09-28").click();
  await element(page.locator("#chosen")).toHaveText("2026-09-28");
  await on("2026-09-28");
});

// The two ways a browser marks a key the input method owns: mid-composition, and by key code 229 alone.
test.each([{ isComposing: true }, { isComposing: false, keyCode: 229 }])("an arrow the input method is composing %j is left alone, then a plain arrow moves", async state => {
  await open();
  await tabIn();
  // True when nothing cancelled the key's default.
  const left = await day("2026-10-01").evaluate((el, init) => el.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true, ...init })), state);
  expect(left).toBe(true);
  await on("2026-10-01");
  await press("ArrowDown");
  await on("2026-10-08");
});
