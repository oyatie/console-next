// SPDX-License-Identifier: LicenseRef-Proprietary
import { resolve } from "node:path";
import { chromium, expect as expectElement, type Browser, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, expect, test } from "vitest";

let server: ViteDevServer;
let browser: Browser;
let page: Page;

beforeAll(async () => {
  server = await createServer({
    configFile: false, cacheDir: ".cache/dialog-test", logLevel: "error",
    optimizeDeps: { include: ["react", "react/jsx-dev-runtime", "react-dom/client", "react-aria-components", "intl-messageformat", "lucide-react"] },
    resolve: { dedupe: ["react", "react-dom"] },
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, fs: { allow: [resolve(".")] } },
    plugins: [{
      name: "dialog-test",
      resolveId: id => id === "/dialog-test.js" ? "\0dialog-test" : undefined,
      load: id => id === "\0dialog-test" ? `
        import { createElement as h, StrictMode, useState } from 'react';
        import { createRoot } from 'react-dom/client';
        import { loadCatalog } from '@console/i18n';
        import { Dialog } from '/apps/web/src/ui/dialog.tsx';
        import { Sheet } from '/apps/web/src/ui/sheet/sheet.tsx';
        await loadCatalog('en');
        function App() {
          const [open, setOpen] = useState(false);
          const [next, setNext] = useState(false);
          const [nested, setNested] = useState(false);
          window.unmount = () => setOpen(false);
          const close = () => setOpen(false);
          const children = [
            h('input', { key: 'input', 'aria-label': 'Name' }),
            h('button', { key: 'close', onClick: close }, 'Close'),
            h('button', { key: 'next', onClick: () => { close(); setNext(true); } }, 'Next'),
            h('button', { key: 'nested', onClick: () => setNested(true) }, 'Nested'),
          ];
          return h('main', null,
            h('div', { inert: true, 'aria-hidden': 'false' }, h('button', { id: 'restricted' }, 'Restricted')),
            h('button', { id: 'opener', onClick: () => setOpen(true) }, 'Open'),
            location.hash === '#sheet'
              ? h(Sheet, { open, title: 'Action', onClose: close, consequence: 'Confirm action', actions: children.slice(1) }, children[0])
              : h(Dialog, { open, title: 'Action', onClose: close }, children),
            h(Dialog, { open: next, title: 'Receipt', onClose: () => setNext(false) }, h('button', { onClick: () => setNext(false) }, 'Done')),
            h(Dialog, { open: nested, title: 'Nested action', onClose: () => setNested(false) }, h('button', { onClick: () => setNested(false) }, 'Back')));
        }
        createRoot(document.getElementById('root')).render(h(StrictMode, null, h(App)));
      ` : undefined,
      configureServer: vite => {
        vite.middlewares.use((req, res, next) => {
          if (req.url !== "/dialog-test") return next();
          res.setHeader("Content-Type", "text/html");
          res.end('<html lang="en"><title>Dialog</title><div id="root"></div><script type="module" src="/dialog-test.js"></script></html>');
        });
      },
    }],
  });
  await server.listen();
  browser = await chromium.launch();
  page = await browser.newPage();
}, 60_000);

afterAll(async () => { await browser?.close(); await server?.close(); });

for (const surface of ["dialog", "sheet"]) {
  test(`${surface} leaves background accessibility attributes under the app's ownership`, async () => {
    await page.goto(`${server.resolvedUrls!.local[0]}dialog-test${surface === "sheet" ? "#sheet" : ""}`);
    await page.locator("#opener").click();
    await expectElement(page.getByRole("dialog", { name: "Action", exact: true })).toBeVisible();
    await expectElement(page.locator("#root")).not.toHaveAttribute("aria-hidden");
    expect(await page.locator("#root").evaluate(el => el instanceof HTMLElement && el.inert)).toBe(true);
    await page.locator("#restricted").evaluate(el => el.parentElement!.setAttribute("aria-hidden", "true"));
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await expectElement(page.locator("#restricted").locator("..")).toHaveAttribute("aria-hidden", "true");
  });

  test(`${surface} hides and disables the background until close, then restores focus`, async () => {
    await page.goto("about:blank");
    await page.goto(`${server.resolvedUrls!.local[0]}dialog-test${surface === "sheet" ? "#sheet" : ""}`);
    const opener = page.locator("#opener");
    await opener.click();
    await expectElement(page.getByRole("dialog", { name: "Action", exact: true })).toBeVisible();
    expect(await opener.evaluate(el => Boolean(el.closest("[inert]")))).toBe(true);
    await opener.evaluate(el => el.focus());
    await expectElement(opener).not.toBeFocused();
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await expectElement(opener).toBeFocused();
    await expectElement(page.getByRole("button", { name: "Open", exact: true })).toBeVisible();
    expect(await page.locator("#restricted").evaluate(el => Boolean(el.closest("[inert]")))).toBe(true);
    await expectElement(page.locator("#restricted").locator("..")).toHaveAttribute("aria-hidden", "false");
  });
}

test("a dialog handover and nested close keep the page inert", async () => {
  await page.goto("about:blank");
  await page.goto(`${server.resolvedUrls!.local[0]}dialog-test`);
  await page.locator("#opener").click();
  await page.getByRole("button", { name: "Nested", exact: true }).click();
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expectElement(page.getByRole("dialog", { name: "Action", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expectElement(page.getByRole("dialog", { name: "Receipt" })).toBeVisible();
  expect(await page.locator("#opener").evaluate(el => Boolean(el.closest("[inert]")))).toBe(true);
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expectElement(page.getByRole("button", { name: "Open", exact: true })).toBeVisible();
});

test("new background content stays isolated and unmount restores its prior accessibility state", async () => {
  await page.goto("about:blank");
  await page.goto(`${server.resolvedUrls!.local[0]}dialog-test`);
  await page.locator("#opener").click();
  await page.evaluate(() => {
    const late = document.createElement("button");
    late.id = "late";
    late.textContent = "Late";
    document.body.append(late);
  });
  expect(await page.locator("#late").evaluate(el => el instanceof HTMLElement && el.inert)).toBe(true);
  await page.evaluate(() => (window as unknown as { unmount: () => void }).unmount());
  await expectElement(page.getByRole("button", { name: "Open", exact: true })).toBeVisible();
  await expectElement(page.getByRole("button", { name: "Late", exact: true })).toBeVisible();
  await expectElement(page.locator("#root")).not.toHaveAttribute("aria-hidden");
  await expectElement(page.locator("#restricted").locator("..")).toHaveAttribute("aria-hidden", "false");
});
