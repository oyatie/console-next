// SPDX-License-Identifier: LicenseRef-Proprietary
import { resolve } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import { chromium, browserTestOptimizeDeps, type Browser, type Page } from "../../../lib/browser-test";

let server: ViteDevServer;
let browser: Browser;
let page: Page;
beforeAll(async () => {
  server = await createServer({
    configFile: false, cacheDir: ".cache/draft-owner-test", logLevel: "error",
    optimizeDeps: browserTestOptimizeDeps, resolve: { dedupe: ["react", "react-dom"] },
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, fs: { allow: [resolve(".")] } },
    plugins: [{
      name: "draft-owner-test", enforce: "pre",
      resolveId: id => id === "@console/api" ? "\0draft-session" : id === "/draft-test.js" ? "\0draft-test" : undefined,
      load: id => id === "\0draft-session" ? `
        export * from '/packages/api/src/index.ts';
        const listeners = new Set();
        export const session = { principal: 'account-a', subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
          change(principal) { this.principal = principal; for (const fn of listeners) fn(); } };
      ` : id === "\0draft-test" ? `
        import { createElement as h } from 'react';
        import { createRoot } from 'react-dom/client';
        import { flushSync } from 'react-dom';
        import { session } from '@console/api';
        import { useDrafts } from '/apps/web/src/features/attendance/ui/use-drafts.ts';
        import { syncDraftPrincipal } from '/apps/web/src/lib/react/draft-owner.ts';
        import { recoveryDraftText } from '/apps/web/src/lib/react/use-draft.ts';
        const people = [{ employee_id: 'employee', name: '김초안' }];
        let store, oldKeep;
        function Probe({ scope }) { store = useDrafts(scope, people); return h('pre', null, JSON.stringify(store.drafts)); }
        const root = createRoot(document.getElementById('root'));
        const render = scope => flushSync(() => root.render(h(Probe, { scope })));
        syncDraftPrincipal(session.principal);
        window.draftTest = {
          render, copy: recoveryDraftText,
          put: value => flushSync(() => store.put('employee|2026-10-01', { value, base: null })),
          putAndCopy: value => { flushSync(() => store.put('employee|2026-10-01', { value, base: null })); return recoveryDraftText(); },
          changeBeforeStorage: () => {
            const tasks = [], original = window.queueMicrotask;
            window.queueMicrotask = task => tasks.push(task);
            try {
              flushSync(() => store.put('employee|2026-10-01', { value: '9-18', base: null }));
              syncDraftPrincipal('account-b');
              session.principal = 'account-b';
              for (const task of tasks.splice(0)) task();
              flushSync(() => session.change('account-b'));
              return store.problem;
            } finally { window.queueMicrotask = original; }
          },
          undo: () => flushSync(() => store.undo()), redo: () => flushSync(() => store.redo()),
          remember: () => { oldKeep = store.keep; },
          keepOld: () => oldKeep('2026-10', 'employee|2026-10-01', { value: 'old account', base: null }),
          change: principal => flushSync(() => { syncDraftPrincipal(principal); session.change(principal); }),
        };
        render('2026-10');
      ` : undefined,
      configureServer: vite => { vite.middlewares.use((req, res, next) => {
        if (req.url !== "/draft-test") return next();
        res.setHeader("Content-Type", "text/html");
        res.end('<div id="root"></div><script type="module" src="/draft-test.js"></script>');
      }); },
    }],
  });
  await server.listen();
  browser = await chromium.launch();
  page = await browser.newPage();
}, 60_000);
afterAll(async () => { await browser?.close(); await server?.close(); });

declare global {
  interface Window {
    draftTest: { render(scope: string): void; copy(): string; put(value: string): void; undo(): void; redo(): void;
      putAndCopy(value: string): string; changeBeforeStorage(): string | null;
      remember(): void; keepOld(): string | null; change(principal: string): void };
  }
}
async function open() {
  await page.goto(`${server.resolvedUrls!.local[0]}draft-test`);
  await page.waitForFunction(() => Boolean(window.draftTest));
}

test("live attendance drafts copy names, preserve undo/redo and restore after a reload", async () => {
  await open();
  await page.evaluate(() => window.draftTest.put("9-18"));
  await page.evaluate(() => window.draftTest.put("9-17"));
  await page.evaluate(() => window.draftTest.undo());
  expect(await page.evaluate(() => window.draftTest.copy())).toBe("2026-10-01 · 김초안 · 9-18");
  await page.evaluate(() => window.draftTest.redo());
  await open();
  await expect.poll(() => page.locator("pre").textContent()).toContain("9-17");
  expect(await page.evaluate(() => window.draftTest.copy())).toBe("2026-10-01 · 김초안 · 9-17");
});

test("recovery copy reflects an edit before deferred storage can run", async () => {
  await open();
  expect(await page.evaluate(() => window.draftTest.putAndCopy("9-16"))).toBe("2026-10-01 · 김초안 · 9-16");
});

test("an account change before deferred storage runs leaves the next account without a storage warning", async () => {
  await open();
  expect(await page.evaluate(() => window.draftTest.changeBeforeStorage())).toBeNull();
  expect(await page.evaluate(() => Object.keys(sessionStorage).filter(k => k.includes("account-a")))).toEqual([]);
});

test("a mounted grid and its delayed editor cleanup cannot carry drafts to the new account", async () => {
  await open();
  await page.evaluate(() => { window.draftTest.put("9-18"); window.draftTest.remember(); });
  await page.evaluate(() => window.draftTest.change("account-b"));
  expect(await page.locator("pre").textContent()).toBe("{}");
  expect(await page.evaluate(() => window.draftTest.keepOld())).toBe("unavailable");
  expect(await page.evaluate(() => window.draftTest.copy())).toBe("");
  expect(await page.evaluate(() => Object.keys(sessionStorage).filter(k => k.includes("account-a")))).toEqual([]);
  await page.evaluate(() => window.draftTest.change("account-a"));
  expect(await page.locator("pre").textContent()).toBe("{}");
});
