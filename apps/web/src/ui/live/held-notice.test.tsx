// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { HeldNotice } from "./held-notice";
import { resolve } from "node:path";
import { realpathSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { expect as element } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { browserEngine, browserTestOptimizeDeps, openBrowserTestPage, type Browser, type Page } from "../../lib/browser-test";

let server: ViteDevServer;
let browser: Browser;
let page: Page;
beforeAll(async () => {
  server = await createServer({
    configFile: false, cacheDir: ".cache/held-notice-test", logLevel: "error",
    optimizeDeps: browserTestOptimizeDeps, resolve: { dedupe: ["react", "react-dom"] },
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, fs: { allow: [resolve("."), realpathSync("node_modules/pretendard")] } },
    plugins: [{ name: "held-notice-test",
      configureServer(vite) {
        vite.middlewares.use((req, res, next) => {
          if (!req.url?.startsWith("/held-notice-test?")) return next();
          res.setHeader("Content-Type", "text/html");
          res.end('<html lang="ko"><title>Live list</title><main id="root"></main><script type="module" src="/held-notice-test.js"></script></html>');
        });
      },
      resolveId: id => id === "/held-notice-test.js" ? "\0held-notice-test" : undefined,
      load: id => id === "\0held-notice-test" ? `
        import React, { useEffect, useState } from 'react';
        import { createRoot } from 'react-dom/client';
        import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
        import { loadCatalog } from '@console/i18n';
        import { HeldNotice } from '/apps/web/src/ui/live/held-notice.tsx';
        import { holdLive, openLive } from '/apps/web/src/lib/live/live.ts';
        import { read } from '/apps/web/src/lib/query.ts';
        import liveStyles from '/apps/web/src/ui/live/live.module.css';
        import '/apps/web/src/app.css';
        await loadCatalog('ko');
        const client = new QueryClient();
        holdLive(true);
        openLive(client, location.origin, options => {
          window.addEventListener('held-change', () => options.onFrame({ event: 'change', data: { type: 'inbox', id: null } }));
          return { get: () => ({ state: 'live', since: 0, partial: [] }), subscribe: () => () => {}, close() {}, reconnect() {} };
        });
        const params = new URLSearchParams(location.search);
        document.documentElement.dataset.theme = params.get('theme') || 'light';
        let reads = 0;
        function Fixture() {
          const [lists, setLists] = useState(Number(params.get('lists') || 1));
          useEffect(() => {
            const add = () => setLists(n => n + 1);
            window.addEventListener('add-list', add);
            const remove = () => setLists(n => Math.max(0, n - 1));
            window.addEventListener('remove-list', remove);
            return () => { window.removeEventListener('add-list', add); window.removeEventListener('remove-list', remove); };
          }, []);
          const { data = [] } = useQuery(read('/api/v1/me/action-inbox', async () => {
              const read = ++reads;
              document.documentElement.dataset.reads = String(read);
              if (read > 1 && params.has('delay')) await new Promise(resolve => window.addEventListener('finish-refresh', resolve, { once: true }));
              return read > 1 && params.has('empty') ? [] : ['row-' + read];
          }));
          return React.createElement(React.Fragment, null,
            React.createElement('button', { id: 'destination' }, 'Destination'),
            React.createElement('aside', null, params.has('notice')
              ? React.createElement('div', { className: 'notice ' + liveStyles.notice }, React.createElement('button', null, 'Changed record'))
              : React.createElement(HeldNotice)),
            ...Array.from({ length: lists }, (_, index) => React.createElement('section', { key: index, 'aria-label': 'List ' + index, tabIndex: -1 },
              React.createElement(HeldNotice, { placement: 'list' }),
              ...data.map(id => React.createElement(params.has('plain') ? 'div' : 'button', { key: id, 'data-id': id, tabIndex: params.has('tab') ? 0 : undefined }, id)))));
        }
        createRoot(document.getElementById('root')).render(React.createElement(QueryClientProvider, { client }, React.createElement(Fixture)));
      ` : undefined }],
  });
  await server.listen();
  browser = await browserEngine().launch();
  page = await browser.newPage();
  await openBrowserTestPage(page, `${server.resolvedUrls!.local[0]}held-notice-test?lists=1`, page.locator('[data-id="row-1"]'));
}, 60_000);
afterAll(async () => { await browser?.close(); await server?.close(); });
beforeEach(async () => {
  await openBrowserTestPage(page, `${server.resolvedUrls!.local[0]}held-notice-test?lists=1`, page.locator('[data-id="row-1"]'));
});

const change = () => page.evaluate(() => window.dispatchEvent(new Event("held-change")));
const chip = () => page.getByRole("button", { name: "새 항목 1건 · 새로 고침", exact: true });

test("the empty status region can render before browser subscriptions mount", () => {
  expect(renderToStaticMarkup(<HeldNotice placement="list" />)).toContain('role="status"');
});

test("the list has an empty mounted status region before changes arrive", async () => {
  const status = page.getByRole("region", { name: "List 0" }).getByRole("status");
  await element(status).toHaveCount(1);
  await element(status).toHaveText("");
  await status.evaluate(el => { el.dataset.sameNode = "yes"; });
  await change();
  await element(status).toHaveText("새 항목 1건 · 새로 고침");
  await element(status).toHaveAttribute("data-same-node", "yes");
  await element(page.locator("aside").getByRole("status")).toHaveCount(0);
});

test("mounting a list hides an existing floater without another change frame", async () => {
  await page.goto(`${server.resolvedUrls!.local[0]}held-notice-test?lists=0`);
  await element(page.locator("html")).toHaveAttribute("data-reads", "1");
  await change();
  const floating = page.locator("aside").getByRole("button");
  await element(floating).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event("add-list")));
  await element(page.locator("section").getByRole("button", { name: "새 항목 1건 · 새로 고침", exact: true })).toBeVisible();
  await element(floating).toHaveCount(0);
});

test("only the last list unmount restores the held shell floater", async () => {
  await page.goto(`${server.resolvedUrls!.local[0]}held-notice-test?lists=2`);
  await element(page.locator("section")).toHaveCount(2);
  await change();
  await element(chip()).toHaveCount(2);
  await element(page.locator("aside").getByRole("button")).toHaveCount(0);
  await page.evaluate(() => window.dispatchEvent(new Event("remove-list")));
  await element(page.locator("section")).toHaveCount(1);
  await element(page.locator("aside").getByRole("button")).toHaveCount(0);
  await page.evaluate(() => window.dispatchEvent(new Event("remove-list")));
  await element(page.locator("section")).toHaveCount(0);
  await element(page.locator("aside").getByRole("button", { name: "새 항목 1건 · 새로 고침" })).toBeVisible();
});

test.each([1, 2])("hiding every mounted list restores the floater with %i lists", async lists => {
  await page.goto(`${server.resolvedUrls!.local[0]}held-notice-test?lists=${lists}`);
  await element(page.locator("section")).toHaveCount(lists);
  await change();
  await element(chip()).toHaveCount(lists);
  const floating = page.locator("aside").getByRole("button");
  await page.locator("section").first().evaluate(el => { el.style.display = "none"; });
  if (lists > 1) {
    await element(floating).toHaveCount(0);
    await element(page.getByRole("status")).toHaveCount(1);
    await page.locator("section").last().evaluate(el => { el.style.display = "none"; });
  }
  await element(page.locator("section").getByRole("button")).toHaveCount(0);
  await element(floating).toBeVisible();
  await page.locator("section").first().evaluate(el => { el.style.removeProperty("display"); });
  await element(page.locator("section").first().getByRole("button", { name: "새 항목 1건 · 새로 고침" })).toBeVisible();
  await element(floating).toHaveCount(0);
  await page.evaluate(() => window.dispatchEvent(new Event("remove-list")));
  if (lists > 1) await page.evaluate(() => window.dispatchEvent(new Event("remove-list")));
  await element(floating).toBeVisible();
});

for (const width of [1440, 390]) for (const placement of ["notice", "held"]) {
  test(`the shell ${placement} stays above sheets and panels at ${width}px`, async () => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${server.resolvedUrls!.local[0]}held-notice-test?lists=0&${placement}`);
    await element(page.locator("html")).toHaveAttribute("data-reads", "1");
    if (placement === "held") await change();
    const button = page.locator("aside").getByRole("button");
    await element(button).toBeVisible();
    for (const layer of ["--z-sheet", "--z-panel"]) {
      const onTop = await button.evaluate((el, layer) => {
        const cover = document.createElement("div");
        cover.style.cssText = `position: fixed; inset: 0; z-index: var(${layer})`;
        document.body.append(cover);
        const rect = el.getBoundingClientRect();
        const hit = el.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
        cover.remove();
        return hit;
      }, layer);
      expect(onTop, layer).toBe(true);
    }
  });
}

for (const width of [1440, 390]) for (const theme of ["light", "dark"]) {
  test(`the chip overlays its list without moving rows at ${width}px ${theme}`, async () => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${server.resolvedUrls!.local[0]}held-notice-test?lists=1&theme=${theme}`);
    const row = page.locator('[data-id="row-1"]');
    await element(row).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    const before = (await row.boundingBox())!;
    const captures = process.env.LIVE_NOTICE_CAPTURES;
    if (captures) {
      await mkdir(captures, { recursive: true });
      await page.screenshot({ path: `${captures}/${width}-${theme}-before.png` });
    }
    await change();
    await element(chip()).toBeVisible();
    expect((await row.boundingBox())!.y).toBe(before.y);
    const bounds = (await chip().boundingBox())!;
    expect(bounds.y).toBeGreaterThanOrEqual(before.y);
    expect(bounds.y).toBeLessThan(before.y + before.height);
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    if (captures) await page.screenshot({ path: `${captures}/${width}-${theme}-after.png` });
    await element(page.locator("html")).toHaveAttribute("data-reads", "1");
    await chip().click();
    await element(page.locator('[data-id="row-2"]')).toBeFocused();
    await element(page.locator("html")).toHaveAttribute("data-reads", "2");
    await element(chip()).toHaveCount(0);
  });
}

test("refreshing to an empty list focuses its region", async () => {
  await page.goto(`${server.resolvedUrls!.local[0]}held-notice-test?lists=1&empty`);
  await element(page.locator('[data-id="row-1"]')).toBeVisible();
  await change();
  await chip().click();
  await element(page.locator("[data-id]")).toHaveCount(0);
  await element(page.getByRole("region", { name: "List 0" })).toBeFocused();
});

test.each(["plain", "plain&tab"])("refresh focuses a %s row and preserves its tab order", async row => {
  await page.goto(`${server.resolvedUrls!.local[0]}held-notice-test?lists=1&${row}`);
  await element(page.locator('[data-id="row-1"]')).toBeVisible();
  await change();
  await element(page.locator("aside").getByRole("button")).toHaveCount(0);
  await chip().click();
  const target = page.locator('[data-id="row-2"]');
  await element(target).toBeFocused();
  await element(target).toHaveAttribute("tabindex", row.includes("tab") ? "0" : "-1");
});

test("a refresh finishing after its list unmounts does not take focus from the next view", async () => {
  await page.goto(`${server.resolvedUrls!.local[0]}held-notice-test?lists=1&delay`);
  await element(page.locator('[data-id="row-1"]')).toBeVisible();
  await change();
  await element(page.locator("aside").getByRole("button")).toHaveCount(0);
  await chip().click();
  await element(page.locator("html")).toHaveAttribute("data-reads", "2");
  await page.evaluate(() => window.dispatchEvent(new Event("remove-list")));
  await element(page.locator("section")).toHaveCount(0);
  const destination = page.locator("#destination");
  await destination.focus();
  await page.evaluate(() => window.dispatchEvent(new Event("finish-refresh")));
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await element(destination).toBeFocused();
});
