// SPDX-License-Identifier: LicenseRef-Proprietary
import { resolve } from "node:path";
import { realpathSync } from "node:fs";
import { chromium, expect as expectDom, type Browser, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, expect, test } from "vitest";
import { browserTestOptimizeDeps, openBrowserTestPage } from "../../lib/browser-test";

let server: ViteDevServer;
let browser: Browser;
let page: Page;

beforeAll(async () => {
  server = await createServer({
    configFile: false,
    cacheDir: ".cache/approval-card-test",
    logLevel: "error",
    optimizeDeps: browserTestOptimizeDeps,
    resolve: { dedupe: ["react", "react-dom"] },
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, fs: { allow: [resolve("."), realpathSync("node_modules/pretendard")] } },
    plugins: [{
      name: "approval-card-test",
      resolveId: (id) => (id === "/approval-card-test.js" ? "\0approval-card-test" : undefined),
      load: (id) => (id === "\0approval-card-test" ? `
        import { createElement as h, useState } from 'react';
        import { createRoot } from 'react-dom/client';
        import { i18n, loadCatalog } from '@console/i18n';
        import { ApprovalCard } from '/apps/web/src/ui/approval-card/approval-card.tsx';
        import '/apps/web/src/app.css';

        await loadCatalog('en');
        i18n.set('en');

        function App() {
          const initialRecorded = new URLSearchParams(location.search).get('recorded') === 'true';
          const [receipt, setReceipt] = useState(initialRecorded ? 'Initial receipt' : '');
          const [count, setCount] = useState(0);
          return h('main', null,
            h('button', { id: 'external', autoFocus: true, onClick: () => setCount((c) => c + 1) }, 'External ' + count),
            h('button', { id: 'record-async', onClick: () => setReceipt('Recorded while form open ' + count) }, 'Record async'),
            h(ApprovalCard, {
              eyebrow: 'OC-2026-0418',
              step: 'My step',
              title: 'Dissolves the support team on 2 Nov',
              consequence: h('p', null, 'Final approval completes the change.'),
              rejectConsequence: h('p', null, 'Returns the request as rejected.'),
              returnConsequence: h('p', null, 'Returns the request for edits.'),
              approveLabel: 'Approve dissolution',
              rejectLabel: 'Reject dissolution',
              returnLabel: 'Return for edits',
              reason: () => h('input', { 'aria-label': 'Reason' }),
              reasonComplete: true,
              onApprove: () => setReceipt('Approved #' + (count + 1)),
              onReject: () => setReceipt('Rejected'),
              onReturn: () => setReceipt('Returned'),
              next: receipt ? h('a', { href: '#next' }, 'Next item') : undefined,
              receipt: receipt ? h('p', { role: 'status' }, receipt) : undefined,
            }, h('p', null, 'Approval details'))
          );
        }

        createRoot(document.getElementById('root')).render(h(App));
      ` : undefined),
      configureServer: (vite) => {
        vite.middlewares.use((req, res, next) => {
          if (req.url?.split("?")[0] !== "/approval-card-test") return next();
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.end('<!doctype html><html lang="en"><head><title>ApprovalCard</title></head><body><div id="root"></div><script type="module" src="/approval-card-test.js"></script></body></html>');
        });
      },
    }],
  });
  await server.listen();
  browser = await chromium.launch();
  page = await browser.newPage();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

const url = (query = "") => `${server.resolvedUrls!.local[0]}approval-card-test${query}`;

test("pre-recorded mount never steals focus and names the recorded article", async () => {
  await openBrowserTestPage(page, url("?recorded=true"), page.getByRole("heading", { name: "Dissolves the support team on 2 Nov" }));
  await expectDom(page.locator("#external")).toBeFocused();
  const article = page.getByRole("article", { name: "Dissolves the support team on 2 Nov" });
  await expectDom(article).toBeVisible();
  await expectDom(article.getByRole("status")).toHaveText("Initial receipt");
});

test("pointer approval moves focus to the recorded h2 only on transition and does not re-steal on re-render", async () => {
  await openBrowserTestPage(page, url(), page.getByRole("button", { name: "Approve dissolution", exact: true }));
  await page.getByRole("button", { name: "Approve dissolution", exact: true }).click();
  const heading = page.getByRole("article", { name: "Dissolves the support team on 2 Nov" }).getByRole("heading", { level: 2 });
  await expectDom(heading).toBeFocused();
  await page.locator("#external").focus();
  await page.locator("#external").click();
  await expectDom(page.locator("#external")).toHaveText("External 1");
  await expectDom(page.locator("#external")).toBeFocused();
});

test("keyboard approval moves focus to the recorded h2 with :focus-visible and form heading shows :focus-visible", async () => {
  await openBrowserTestPage(page, url(), page.getByRole("button", { name: "Reject", exact: true }));
  await page.getByRole("button", { name: "Reject", exact: true }).focus();
  await page.keyboard.press("Enter");
  const formHeading = page.getByRole("heading", { level: 3, name: "Reject dissolution" });
  await expectDom(formHeading).toBeFocused();
  expect(await formHeading.evaluate((el) => el.matches(":focus-visible") && getComputedStyle(el).outlineStyle !== "none")).toBe(true);

  await page.keyboard.press("Escape");
  const approve = page.getByRole("button", { name: "Approve dissolution", exact: true });
  await approve.focus();
  await page.keyboard.press("Enter");
  const doneHeading = page.getByRole("article", { name: "Dissolves the support team on 2 Nov" }).getByRole("heading", { level: 2 });
  await expectDom(doneHeading).toBeFocused();
  expect(await doneHeading.evaluate((el) => el.matches(":focus-visible") && getComputedStyle(el).outlineStyle !== "none")).toBe(true);
});

test("transitioning into recorded while a reason form is open moves focus to the recorded h2", async () => {
  await openBrowserTestPage(page, url(), page.getByRole("button", { name: "Request changes", exact: true }));
  await page.getByRole("button", { name: "Request changes", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expectDom(page.getByRole("heading", { level: 3, name: "Return for edits" })).toBeFocused();
  // The receipt arrives on its own, so the trigger must not take the focus the form holds.
  await page.locator("#record-async").dispatchEvent("click");
  const doneHeading = page.getByRole("article", { name: "Dissolves the support team on 2 Nov" }).getByRole("heading", { level: 2 });
  await expectDom(doneHeading).toBeFocused();
  await expectDom(page.getByRole("status")).toHaveText("Recorded while form open 0");
});

test("a receipt that arrives while focus is on a control outside the card leaves focus there", async () => {
  await openBrowserTestPage(page, url(), page.getByRole("button", { name: "Approve dissolution", exact: true }));
  await expectDom(page.locator("#external")).toBeFocused();
  await page.locator("#record-async").dispatchEvent("click");
  await expectDom(page.getByRole("status")).toHaveText("Recorded while form open 0");
  await expectDom(page.locator("#external")).toBeFocused();
  await page.keyboard.press("Enter");
  await expectDom(page.locator("#external")).toHaveText("External 1");
});
