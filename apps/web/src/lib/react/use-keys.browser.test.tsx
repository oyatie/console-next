// SPDX-License-Identifier: LicenseRef-Proprietary
import { browserTestOptimizeDeps, openBrowserTestPage, waitForBrowserTestPage } from "../browser-test";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createServer, searchForWorkspaceRoot, type ViteDevServer } from "vite";
import { chromium, type Browser, type Page } from "@playwright/test";

let server: ViteDevServer;
let browser: Browser;
let page: Page;
const FIXTURE = "/__use-keys-test.tsx";

beforeAll(async () => {
  server = await createServer({
    configFile: false, appType: "custom", cacheDir: ".cache/vite-use-keys-test", optimizeDeps: browserTestOptimizeDeps,
    resolve: { dedupe: ["react", "react-dom"] },
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, fs: { allow: [searchForWorkspaceRoot(process.cwd())] } },
    plugins: [{
      name: "use-keys-test",
      configureServer(s) {
        s.middlewares.use((req, res, next) => {
          if (req.url !== "/use-keys-fixture") return next();
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.end(`<!doctype html><html lang="ko"><head><title>Keys</title></head><body><div id="root"></div><script type="module" src="${FIXTURE}"></script></body></html>`);
        });
      },
      resolveId: id => id === FIXTURE ? id : undefined,
      load: id => id === FIXTURE ? `
        import React from "react";
        import { createRoot } from "react-dom/client";
        import { flushSync } from "react-dom";
        import { useKeys } from "/apps/web/src/lib/react/use-keys.ts";
        const h = React.createElement;
        window.heard = [];
        function App() {
          const [dialog, setDialog] = React.useState(false);
          const [tag, setTag] = React.useState("initial");
          window.syncAndPress = () => {
            flushSync(() => setTag("updated"));
            document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "j", code: "KeyJ", bubbles: true, cancelable: true }));
          };
          useKeys({ "card.next": () => window.heard.push("next:" + tag), "card.section": (_, n) => window.heard.push("section " + n), "registerRun.next": () => window.heard.push("save") });
          // Like the app's text input: Enter's default is prevented so the form does not submit, and the event goes on.
          const enter = e => e.key === "Enter" && e.preventDefault();
          return h("main", null, h("h1", null, "Keys"), h("input", { "aria-label": "Name", onKeyDown: enter }),
            h("button", { onClick: () => setDialog(true) }, "Open"), dialog && h("div", { role: "dialog", "aria-label": "Sheet" }, "Sheet"));
        }
        createRoot(document.getElementById("root")).render(h(App));` : undefined,
    }],
  });
  await server.listen();
  browser = await chromium.launch();
  page = await browser.newPage();
  const { port } = server.httpServer!.address() as { port: number };
  await openBrowserTestPage(page, `http://127.0.0.1:${port}/use-keys-fixture`, page.getByRole("heading", { name: "Keys" }));
}, 120_000);
afterAll(async () => { await browser?.close(); await server?.close(); });

const heard = () => page.evaluate(() => (window as unknown as { heard: string[] }).heard.splice(0));
// The jamo a Korean input mode reports for the J position.
const jamo = { key: "ㅓ", code: "KeyJ" };
const send = (init: { key: string; code: string; isComposing?: boolean }) =>
  page.evaluate(i => document.body.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...i })), init);

test("a screen's keys work in a Korean input mode, stay out of fields and composition, reach a field chord, and wait for a dialog", async () => {
  await page.keyboard.press("j");
  await page.keyboard.press("3");
  expect(await heard()).toEqual(["next:initial", "section 3"]);

  await send(jamo);
  await send({ ...jamo, isComposing: true });
  await send({ key: "Process", code: "KeyJ" });
  expect(await heard()).toEqual(["next:initial"]);

  await page.getByRole("textbox", { name: "Name" }).fill("");
  await page.keyboard.press("j");
  await expect.poll(() => page.getByRole("textbox", { name: "Name" }).inputValue()).toBe("j");
  expect(await heard()).toEqual([]);
  // A field that prevents Enter's default still lets a field chord through.
  await page.keyboard.press("ControlOrMeta+Enter");
  expect(await heard()).toEqual(["save"]);

  await page.getByRole("button", { name: "Open" }).click();
  await page.keyboard.press("j");
  expect(await heard()).toEqual([]);
}, 60_000);

test("with single keys off on this device a page key calls nothing, a chord still does, and turning them on needs no reload", async () => {
  // A fresh page: the dialog the test above left open would hold every page key back by itself.
  await page.reload({ waitUntil: "commit" });
  await waitForBrowserTestPage(page, page.getByRole("heading", { name: "Keys" }));
  await page.keyboard.press("j");
  expect(await heard()).toEqual(["next:initial"]);
  try {
    await page.evaluate(() => localStorage.setItem("console.singleKeys", "off"));
    await page.keyboard.press("j");
    await page.keyboard.press("3");
    await send(jamo);
    expect(await heard()).toEqual([]);
    await page.keyboard.press("ControlOrMeta+Enter");
    expect(await heard()).toEqual(["save"]);
    await page.evaluate(() => localStorage.removeItem("console.singleKeys"));
    await page.keyboard.press("j");
    await page.keyboard.press("3");
    expect(await heard()).toEqual(["next:initial", "section 3"]);
  } finally { await page.evaluate(() => localStorage.removeItem("console.singleKeys")); }
}, 60_000);

test("useKeys sees updated handler refs synchronously after flushSync before passive effects", async () => {
  await page.reload({ waitUntil: "commit" });
  await waitForBrowserTestPage(page, page.getByRole("heading", { name: "Keys" }));
  await page.evaluate(() => (window as unknown as { syncAndPress: () => void }).syncAndPress());
  expect(await heard()).toEqual(["next:updated"]);
}, 60_000);
