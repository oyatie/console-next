// SPDX-License-Identifier: LicenseRef-Proprietary
import { resolve } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import { expect as browserExpect } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { chromium, browserTestOptimizeDeps, type Browser, type Page } from "../../../lib/browser-test";

const current = "김담당";
const changed = "박담당";
const reference = "0123456789abcdef0123456789abcdef";
let server: ViteDevServer;
let browser: Browser;
let pages: Page[];
beforeAll(async () => {
  await loadCatalog("ko");
  server = await createServer({
    configFile: false, cacheDir: ".cache/profile-name-test", logLevel: "error",
    optimizeDeps: browserTestOptimizeDeps,
    resolve: { dedupe: ["react", "react-dom"] },
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, fs: { allow: [resolve(".")] } },
    plugins: [{
      name: "profile-name-test",
      resolveId: id => id === "/profile-name-test.js" ? "\0profile-name-test" : undefined,
      load: id => id === "\0profile-name-test" ? `
        import { createElement as h } from 'react';
        import { createRoot } from 'react-dom/client';
        import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
        import { createRootRoute, createRouter, createMemoryHistory, RouterProvider } from '@tanstack/react-router';
        import { configure } from '@console/api';
        import { loadCatalog } from '@console/i18n';
        import { bindAnnouncer } from '/apps/web/src/lib/react/announce.ts';
        import { ProfileName } from '/apps/web/src/features/account/ui/profile-name.tsx';
        await loadCatalog('ko');
        configure({baseUrl:location.origin,refresh:{kind:'cookie'},passkeys:{get:async()=>null,create:async()=>null}});
        window.announcements = [];
        bindAnnouncer(message => window.announcements.push(message));
        const routeTree = createRootRoute({component:()=>h(ProfileName,{current:${JSON.stringify(current)}})});
        const router = createRouter({routeTree,history:createMemoryHistory({initialEntries:['/']})});
        createRoot(document.getElementById('root')).render(h(QueryClientProvider,{client:new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}})},h(RouterProvider,{router})));
      ` : undefined,
      configureServer: vite => { vite.middlewares.use((req, res, next) => {
        if (req.url !== "/profile-name-test") return next();
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end('<!doctype html><html lang="ko"><head><title>계정</title></head><body><div id="root"></div><script type="module" src="/profile-name-test.js"></script></body></html>');
      }); },
    }],
  });
  await server.listen();
  browser = await chromium.launch();
  pages = await Promise.all(Array.from({ length: 7 }, () => browser.newPage()));
}, 60_000);
afterAll(async () => { await browser?.close(); await server?.close(); });

const announcements = (page: Page) => page.evaluate(() => (window as unknown as { announcements: string[] }).announcements);
async function open(page: Page, name: string) {
  await page.goto(`${server.resolvedUrls!.local[0]}profile-name-test`);
  await page.getByRole("button", { name: t("account.name.edit"), exact: true }).click();
  const dialog = page.getByRole("dialog", { name: t("account.name.edit") });
  await dialog.getByRole("textbox").fill(name);
  return dialog;
}

test.each([current, `  ${current}  `])("an unchanged name (%s) closes without PATCH or a saved announcement even when PATCH would fail", async name => {
  const page = pages.shift()!;
  let writes = 0;
  await page.route("**/api/v1/users/me", route => {
    if (route.request().method() === "GET") return route.fulfill({ json: { display_name: current } });
    writes++;
    return route.fulfill({ status: 500, json: { error: { code: "internal", message: "internal server error" } } });
  });
  try {
    const dialog = await open(page, name);
    await dialog.getByRole("button", { name: t("account.name.edit"), exact: true }).click();
    await browserExpect(dialog).toHaveCount(0);
    expect.soft(writes).toBe(0);
    expect(await announcements(page)).toEqual([]);
  } finally { await page.close(); }
});

test.each([500, 403, 0])("a changed name keeps status %s in the dialog with the shared outcome and correct retry state", async status => {
  const page = pages.shift()!;
  let writes = 0, reads = 0;
  await page.route("**/api/v1/users/me", route => {
    if (route.request().method() === "GET") {
      reads++;
      return status === 0 ? route.abort() : route.fulfill({ json: { display_name: current } });
    }
    writes++;
    return status === 0 ? route.abort() : route.fulfill({ status, json: { error: { code: status === 403 ? "forbidden" : "internal", message: "refused", support_ref: reference } } });
  });
  try {
    const dialog = await open(page, changed);
    const submit = dialog.getByRole("button", { name: t("account.name.edit"), exact: true });
    await submit.click();
    const banner = dialog.getByRole(status === 403 ? "alert" : "status");
    await browserExpect(banner).toBeVisible();
    await browserExpect(banner).toHaveAttribute("data-tone", status === 403 ? "danger" : "info");
    if (status === 403) {
      await browserExpect(banner).toContainText("refused");
      await browserExpect(submit).toBeEnabled();
      expect(reads).toBe(0);
    } else {
      await browserExpect(banner).toContainText(t("requestOutcome.checking"));
      await browserExpect(banner).toContainText(t("requestOutcome.remedy"));
      await browserExpect(banner.getByRole("button", { name: t("requestOutcome.check"), exact: true })).toBeEnabled();
      await browserExpect(submit).toBeDisabled();
      expect(reads).toBe(1);
    }
    if (status === 500) await browserExpect(banner.getByText(`ref ${reference.slice(0, 8)}`, { exact: true })).toBeVisible();
    await browserExpect(dialog.getByRole("textbox")).toHaveValue(changed);
    expect(writes).toBe(1);
    expect(await announcements(page)).toEqual([]);
  } finally { await page.close(); }
});

test("the form stays busy while a failed save checks the profile, then shows its uncertain outcome", async () => {
  const page = pages.shift()!;
  let release!: () => void;
  const held = new Promise<void>(done => { release = done; });
  await page.route("**/api/v1/users/me", async route => {
    if (route.request().method() === "PATCH") return route.fulfill({ status: 500, json: { error: { code: "internal", message: "refused" } } });
    await held;
    if (!page.isClosed()) await route.fulfill({ json: { display_name: current } });
  });
  try {
    const dialog = await open(page, changed);
    const reread = page.waitForRequest(request => request.method() === "GET" && request.url().endsWith("/api/v1/users/me"));
    await dialog.getByRole("button", { name: t("account.name.edit"), exact: true }).click();
    await reread;
    await browserExpect(dialog.locator("form")).toHaveAttribute("aria-busy", "true");
    release();
    await browserExpect(dialog.getByRole("status")).toContainText(t("requestOutcome.checking"));
    await browserExpect(dialog.locator("form")).toHaveAttribute("aria-busy", "false");
  } finally { release(); await page.close(); }
});

test("a changed name still saves its trimmed value and announces a confirmed success", async () => {
  const page = pages.shift()!;
  const writes: unknown[] = [];
  await page.route("**/api/v1/users/me", route => {
    writes.push(route.request().postDataJSON());
    return route.fulfill({ json: { display_name: changed } });
  });
  try {
    const dialog = await open(page, `  ${changed}  `);
    await dialog.getByRole("button", { name: t("account.name.edit"), exact: true }).click();
    await browserExpect(dialog).toHaveCount(0);
    expect(writes).toEqual([{ display_name: changed }]);
    expect(await announcements(page)).toEqual([t("account.name.saved")]);
  } finally { await page.close(); }
});
