// SPDX-License-Identifier: LicenseRef-Proprietary
import { browserTestOptimizeDeps } from "../../lib/browser-test";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type Browser, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, expect, test } from "vitest";

let server: ViteDevServer;
let browser: Browser;
let page: Page;
beforeAll(async () => {
  server = await createServer({
    configFile: false, cacheDir: ".cache/composer-test", logLevel: "error",
    optimizeDeps: browserTestOptimizeDeps,
    resolve: { dedupe: ["react", "react-dom"] },
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, fs: { allow: [resolve("."), realpathSync("node_modules/pretendard")] } },
    plugins: [{
      name: "composer-test",
      resolveId: (id) => id === "/composer-test.js" ? "\0composer-test" : undefined,
      load: (id) => id === "\0composer-test" ? `
        import { createElement as h, useState } from 'react';
        import { createRoot } from 'react-dom/client';
        import { loadCatalog } from '@console/i18n';
        import { Composer } from '/apps/web/src/ui/composer/composer.tsx';
        import { TextArea } from '/apps/web/src/ui/field/text-area.tsx';
        import '/apps/web/src/app.css';
        await loadCatalog('ko');
        function Demo() {
          const [long, setLong] = useState(false);
          const [submits, setSubmits] = useState(0);
          const [remedies, setRemedies] = useState(0);
          const state = new URLSearchParams(location.search).get('state');
          return h('main', null, h('h1', null, 'Record'),
            h('button', { id: 'toggle', onClick: () => setLong(x => !x) }, 'Change action'),
            h(Composer, { layout: state === 'drawer' ? 'drawer' : state?.startsWith('page') ? 'page' : 'inline', headingLevel: 3, commitId: 'commit',
              title: 'Review', action: { kind: long ? 'EMPLOYMENT_TYPE_CHANGE' : 'appointment', mode: long ? 'apply' : 'schedule', count: 3 },
              onClose: () => {}, onSubmit: state === 'refusal' ? undefined : () => setSubmits(x => x + 1),
              blocked: state === 'blocked' || state?.startsWith('locate') || (state === 'page-blocked' && !long) ? { reason: 'Resolve first', remedy: h('button', { id: 'remedy', onClick: () => setRemedies(x => x + 1) }, 'Register entity'), press: state?.startsWith('locate') ? () => setRemedies(x => x + 1) : undefined } : undefined,
              pending: state === 'locate-pending', loading: state === 'locate-loading',
              locked: state === 'locked' || state === 'locate-locked', recovery: state === 'recovery' ? h('span', null, 'Checking') : undefined,
            }, state === 'refusal' ? h('form', { onSubmit: event => { event.preventDefault(); setRemedies(x => x + 1); } }, h('input', { 'aria-label': 'Reason' }), h('button', { type: 'submit' }, 'Request access')) : h(TextArea, { 'aria-label': 'Reason' })),
            h('output', { id: 'submits' }, submits), h('output', { id: 'remedies' }, remedies));
        }
        createRoot(document.getElementById('root')).render(h(Demo));
      ` : undefined,
      configureServer: (vite) => { vite.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith("/composer-test?")) return next();
        res.setHeader("Content-Type", "text/html");
        res.end('<html lang="ko"><title>Composer</title><div id="root"></div><script type="module" src="/composer-test.js"></script></html>');
      }); },
    }],
  });
  await server.listen();
  browser = await chromium.launch();
  page = await browser.newPage();
  page.setDefaultTimeout(10000);
}, 60_000);

test.each([390, 1440])("resolving a page block keeps both controls fixed at %ipx", async (width) => {
  await page.setViewportSize({ width, height: 900 });
  await open("page-blocked");
  const boxes = async () => Promise.all([page.locator("#commit"), page.getByRole("button", { name: "닫기", exact: true })].map((button) => button.boundingBox()));
  const before = await boxes();
  await page.locator("#toggle").click();
  await page.locator('#commit[type="submit"]').waitFor();
  expect(await boxes()).toEqual(before);
});
afterAll(async () => { await browser?.close(); await server?.close(); });

const open = async (state: string) => {
  await page.goto(`${server.resolvedUrls!.local[0]}composer-test?state=${state}`);
  await page.getByRole("heading", { name: "Review" }).waitFor();
};

test.each(["blocked", "locked", "recovery"])("%s refuses native form submission", async (state) => {
  await open(state);
  await page.locator("form").evaluate((form) => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(await page.locator("#submits").textContent()).toBe("0");
  if (state === "blocked") {
    await page.locator("#remedy").click();
    expect(await page.locator("#remedies").textContent()).toBe("1");
  }
});

test("a refusal's recovery form submits independently without a composer commit", async () => {
  await open("refusal");
  expect(await page.locator("form").count()).toBe(1);
  expect(await page.locator("#commit").count()).toBe(0);
  await page.getByLabel("Reason").fill("Reviewed");
  await page.getByLabel("Reason").press("Enter");
  await page.waitForFunction(() => document.querySelector("#remedies")?.textContent === "1");
  expect(await page.locator("#submits").textContent()).toBe("0");
});

test.each(["locate", "locate-pending", "locate-loading", "locate-locked"])("%s only runs the opted-in blocked press when editable", async (state) => {
  await open(state);
  await page.locator("#commit").click({ force: true });
  expect(await page.locator("#remedies").textContent()).toBe(state === "locate" ? "1" : "0");
  await page.getByLabel("Reason").press("Control+Enter");
  expect(await page.locator("#remedies").textContent()).toBe(state === "locate" ? "2" : "0");
  await page.locator("form").evaluate((form) => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(await page.locator("#submits").textContent()).toBe("0");
});

test.each([[390, "inline"], [1440, "inline"], [390, "page"], [1440, "page"]] as const)("commit and dismiss boxes stay fixed at %ipx in %s", async (width, state) => {
  await page.setViewportSize({ width, height: 900 });
  await open(state);
  const boxes = async () => Promise.all([page.locator('button[type="submit"]'), page.getByRole("button", { name: "닫기", exact: true })].map((button) => button.boundingBox()));
  const before = await boxes();
  await page.locator("#toggle").click();
  await page.getByRole("button", { name: /고용 형태 변경/ }).waitFor();
  expect(await boxes()).toEqual(before);
  await page.getByLabel("Reason").fill("Reviewed");
  await page.getByLabel("Reason").press("Control+Enter");
  expect(await page.locator("#submits").textContent()).toBe("1");
});

test("composition-ending keyCode 229 in a textarea cannot commit", async () => {
  await open("page");
  const field = page.getByLabel("Reason");
  await field.focus();
  await field.dispatchEvent("compositionstart");
  await field.dispatchEvent("keydown", { key: "Enter", metaKey: true, isComposing: false, keyCode: 229 });
  expect(await page.locator("#submits").textContent()).toBe("0");
  await field.dispatchEvent("compositionend");
  await field.press("Control+Enter");
  expect(await page.locator("#submits").textContent()).toBe("1");
});
