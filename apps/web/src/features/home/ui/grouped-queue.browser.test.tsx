// SPDX-License-Identifier: LicenseRef-Proprietary
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, firefox, expect as pw, type Browser, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, expect, test } from "vitest";
import type { components } from "@console/api/schema";
import { browserTestOptimizeDeps } from "../../../lib/browser-test";

type Item = components["schemas"]["ActionInboxItem"];
const item = (id: string, extra: Partial<Item> = {}): Item => ({ id, kind: "register_review", title: id, ref: "", lane: "turn", urg: "wait", dueTone: "neutral", days_remaining: null, done: false, links: [], ...extra });
let server: ViteDevServer;
const sessions: { browser: Browser; page: Page }[] = [];
beforeAll(async () => {
  server = await createServer({ configFile: false, cacheDir: ".cache/grouped-queue-test", logLevel: "error",
    optimizeDeps: browserTestOptimizeDeps,
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, fs: { allow: [resolve("."), realpathSync("node_modules/pretendard")] } },
    plugins: [{ name: "queue-test", resolveId: id => id === "/queue-test.js" ? "\0queue-test" : undefined,
      load: id => id === "\0queue-test" ? `
        import {createElement as h} from 'react'; import {createRoot} from 'react-dom/client'; import {flushSync} from 'react-dom';
        import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
        import {createMemoryHistory,createRootRoute,createRouter,RouterContextProvider} from '@tanstack/react-router';
        import {loadCatalog} from '@console/i18n';
        import {GroupedQueue} from '/apps/web/src/features/home/ui/grouped-queue.tsx';
        import '/apps/web/src/app.css';
        await loadCatalog('ko');
        const root=createRoot(document.getElementById('queue')),client=new QueryClient(); let version=0;
        const router=createRouter({routeTree:createRootRoute(),history:createMemoryHistory({initialEntries:['/']})});
        window.showQueue=items=>flushSync(()=>root.render(h(QueryClientProvider,{client},h(RouterContextProvider,{router},h(GroupedQueue,{items,key:++version})))));
      ` : undefined,
      configureServer: vite => { vite.middlewares.use((req, res, next) => {
        if (req.url !== "/queue-test") return next();
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end('<!doctype html><html lang="ko"><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>업무함</title></head><body><div class="shell"><aside class="rail"></aside><header class="top"></header><main class="main"><div class="page"><section class="card panel" id="queue"></section></div></main></div><script type="module" src="/queue-test.js"></script></body></html>');
      }); },
    }],
  });
  await server.listen();
  for (const engine of [chromium, firefox]) {
    const browser = await engine.launch();
    const page = await browser.newPage();
    sessions.push({ browser, page });
    await page.goto(`${server.resolvedUrls!.local[0]}queue-test`);
    await page.waitForFunction(() => "showQueue" in window);
  }
}, 60_000);
afterAll(async () => { await Promise.all(sessions.map(({ browser }) => browser.close())); await server?.close(); });

test.each([0, 1].flatMap(engine => [1440, 390].map(width => ({ engine, width }))))("queue cells stay inside each row at $width px, engine $engine, both themes", async ({ engine, width }) => {
    const { page } = sessions[engine]!;
    await page.setViewportSize({ width, height: 900 });
    const items = [
      ...Array.from({ length: 16 }, (_, i) => item(`명부 확인 ${i + 1}`)),
      item("이번 주 업무", { due: "2026-10-29T00:00:00Z", days_remaining: 3, dueTone: "warn" }),
      item("오늘 퇴직", { kind: "hr_exit_confirm", due: "2026-10-26T00:00:00Z", days_remaining: 0, dueTone: "danger", links: [{ kind: "exit_case", id: "exit" }] }),
      item("긴 역할", { kind: "grant_notice", title: "RegionalOperationsReviewer".repeat(4), links: [{ kind: "access", id: "long-role" }], who: "박사원" }),
      item("보안 점검", { kind: "account_security", links: [{ kind: "account", id: "member" }], context: { is_ops: true } }),
      item("첫 신고", { kind: "insurance_filing", fold_key: "insurance:person:case", links: [{ kind: "statutory", id: "case" }] }),
      item("둘째 신고", { kind: "insurance_filing", fold_key: "insurance:person:case", links: [{ kind: "statutory", id: "case" }] }),
      item("미지원 링크", { links: [{ kind: "approval_run", id: "run" }] }),
    ];
    await page.evaluate(value => (window as unknown as { showQueue: (items: Item[]) => void }).showQueue(value), items);
    const rows = page.locator('[data-id]');
    await pw(rows).toHaveCount(22);
    expect(await rows.first().innerText()).toContain("오늘 퇴직");
    expect(await rows.nth(1).innerText()).toContain("이번 주 업무");
    if (width === 390) {
      await pw(page.getByRole("table").first()).toHaveAttribute("aria-colcount", "6");
      await pw(rows.first().getByRole("cell").last()).toHaveAttribute("aria-colindex", "6");
      await page.getByRole("button", { name: "오늘 퇴직 작업", exact: true }).click();
      await pw(page.getByRole("dialog").getByRole("link", { name: "인사 확인하고 퇴직 처리", exact: true })).toBeVisible();
      await page.keyboard.press("Escape");
    }
    await page.getByRole("button", { name: "4대보험 신고 · 2건", exact: true }).click();
    await pw(page.getByText("둘째 신고", { exact: true }).filter({ visible: true })).toBeVisible();
    for (const theme of ["light", "dark"]) {
      await page.locator("html").evaluate((el, value) => el.dataset.theme = value, theme);
      await page.evaluate(() => document.fonts.ready);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
      expect(await page.locator("main").evaluate(el => el.scrollWidth - el.clientWidth)).toBe(0);
      expect(await rows.evaluateAll(elements => elements.flatMap(row => {
        const box = row.getBoundingClientRect();
        const card = document.querySelector(".panel")!.getBoundingClientRect();
        return [...row.querySelectorAll('[role="cell"], td')].filter(cell => cell.closest('[data-id]') === row && getComputedStyle(cell).display !== "none").flatMap(cell => {
          const b = cell.getBoundingClientRect();
          return b.width && (b.left < box.left - 1 || b.right > box.right + 1 || b.top < box.top - 1 || b.bottom > box.bottom + 1 || b.right > card.right + 1)
            ? [{ row: row.getAttribute("data-id"), cell: cell.textContent }] : [];
        });
      }))).toEqual([]);
      expect(await page.locator('[data-id] .btn--primary').count()).toBe(0);
      const first = (await rows.first().boundingBox())!;
      expect(first.y + first.height).toBeLessThan(900);
    }
    await pw(page.getByText("오늘 퇴직", { exact: true })).toHaveCount(1);
    await pw(page.getByRole("button", { name: "명부 확인 1 작업", exact: true })).toHaveCount(0);
    await pw(page.getByRole("button", { name: "미지원 링크 작업", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "4대보험 신고 · 2건", exact: true }).click();
}, 30_000);
