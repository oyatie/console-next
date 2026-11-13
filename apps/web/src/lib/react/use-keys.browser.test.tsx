// SPDX-License-Identifier: LicenseRef-Proprietary
import { browserTestOptimizeDeps, openBrowserTestPage } from "../browser-test";
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
        import { useKeys } from "/apps/web/src/lib/react/use-keys.ts";
        const h = React.createElement;
        window.heard = [];
        function App() {
          const [dialog, setDialog] = React.useState(false);
          useKeys({ "card.next": () => window.heard.push("next"), "card.section": (_, n) => window.heard.push("section " + n), "registerRun.next": () => window.heard.push("save") });
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
const send = (init: { key: string; code: string; isComposing?: boolean }) =>
  page.evaluate(i => document.body.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...i })), init);

test("a screen's keys work in a Korean input mode, stay out of fields and composition, reach a field chord, and wait for a dialog", async () => {
  await page.keyboard.press("j");
  await page.keyboard.press("3");
  expect(await heard()).toEqual(["next", "section 3"]);

  // A Korean input mode reports the jamo for the J position.
  await send({ key: "ㅓ", code: "KeyJ" });
  await send({ key: "ㅓ", code: "KeyJ", isComposing: true });
  await send({ key: "Process", code: "KeyJ" });
  expect(await heard()).toEqual(["next"]);

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
