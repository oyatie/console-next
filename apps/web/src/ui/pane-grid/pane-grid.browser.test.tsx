// SPDX-License-Identifier: LicenseRef-Proprietary
import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createServer, type ViteDevServer } from "vite";
import { loadCatalog, t } from "@console/i18n";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { browserEngine, browserTestOptimizeDeps, openBrowserTestPage, type Browser, type Page } from "../../lib/browser-test";
import { mountGalleryEntry, scanWcag22Matrix, type MountedGallery } from "../../lib/gallery-browser-test";

let mounted: MountedGallery;

beforeAll(async () => {
  await loadCatalog("ko");
  mounted = await mountGalleryEntry({
    name: "pane-grid",
    entryPath: "/apps/web/src/ui/pane-grid/pane-grid.gallery.tsx",
    readySelector: "[data-pane-grid-gallery]",
  });
}, 60_000);

afterAll(async () => {
  await mounted?.close();
});

test("PaneGrid passes WCAG 2.2 AA axe checks and closes the side pane on Escape while dispatching open-in-tab", async () => {
  const { page } = mounted;
  expect(await scanWcag22Matrix(page)).toEqual([]);

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => {
    document.documentElement.dataset.experience = "console";
    document.documentElement.dataset.theme = "light";
    (window as unknown as { openedTab?: unknown }).openedTab = null;
    window.addEventListener(
      "console:open-workspace-tab",
      event => {
        (window as unknown as { openedTab?: unknown }).openedTab = (event as CustomEvent).detail;
      },
      { once: true },
    );
  });

  await page.getByRole("button", { name: t("uiFlexibleColumns.openInTab") }).click();
  const openedTab = await page.evaluate(() => (window as unknown as { openedTab?: { href: string } }).openedTab);
  expect(openedTab?.href).toBe("/people");

  await page.locator('[data-pane="record"] button').first().focus();
  await page.keyboard.press("Escape");
  expect(await page.locator('[data-pane="record"]').count()).toBe(0);
});

describe("StrictMode PaneGrid", () => {
  const slug = "pane-grid-strict-test";
  let server: ViteDevServer;
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    server = await createServer({
      configFile: false,
      cacheDir: `.cache/${slug}`,
      logLevel: "error",
      optimizeDeps: browserTestOptimizeDeps,
      resolve: { dedupe: ["react", "react-dom"] },
      server: {
        host: "127.0.0.1",
        port: 0,
        watch: null,
        hmr: false,
        fs: { allow: [resolve("."), dirname(realpathSync("node_modules/pretendard"))] },
      },
      plugins: [{
        name: slug,
        resolveId: id => (id === `/${slug}.js` ? `\0${slug}` : undefined),
        load: id =>
          id === `\0${slug}`
            ? `
          import React, { StrictMode, useRef, useState } from 'react';
          import { flushSync } from 'react-dom';
          import { createRoot } from 'react-dom/client';
          import { loadCatalog } from '@console/i18n';
          import { PaneGrid } from '/apps/web/src/ui/pane-grid/pane-grid.tsx';
          import { usePublishedStatusBar, useScreenStatusBar } from '/apps/web/src/ui/status-bar/status-bar-store.ts';
          import '/apps/web/src/app.css';
          await loadCatalog('ko');
          function StatusSubscriber() {
            const segments = usePublishedStatusBar();
            const renders = useRef(0);
            renders.current += 1;
            return React.createElement('div', {
              'data-status-renders': String(renders.current),
              'data-status-count': String(segments?.length ?? 0),
            });
          }
          function StatusPublisher() {
            const [tick, setTick] = useState(0);
            useScreenStatusBar([
              { id: 'scope', content: 'Workspace', tone: 'strong' },
              { id: 'count', content: '2 rows' },
            ]);
            return React.createElement('button', { type: 'button', 'data-rerender': '', onClick: () => setTick(n => n + 1) }, 'Rerender ' + tick);
          }
          function App() {
            const [selected, setSelected] = useState(null), [opened, setOpened] = useState(''), [relatedOpen, setRelatedOpen] = useState(false);
            const [declineClose, setDeclineClose] = useState(false), [selectLog, setSelectLog] = useState([]), [restoreCalls, setRestoreCalls] = useState(0);
            const rowA = useRef(null), rowB = useRef(null), rowC = useRef(null), outsideBtn = useRef(null);
            const handleSelect = id => { setSelected(id); setSelectLog(prev => [...prev, id]); };
            const reset = () => { setSelected(null); setOpened(''); setRelatedOpen(false); setDeclineClose(false); setSelectLog([]); setRestoreCalls(0); };
            return React.createElement('main', {
              'data-strict-pane-grid': '', 'data-opened': opened, 'data-selected': selected ?? '',
              'data-select-log': selectLog.join(','), 'data-restore-calls': String(restoreCalls),
            },
              React.createElement(StatusSubscriber), React.createElement(StatusPublisher),
              React.createElement('button', { ref: outsideBtn, type: 'button', 'data-outside': '' }, 'Outside'),
              React.createElement('button', { type: 'button', 'data-reset': '', onClick: reset }, 'Reset'),
              React.createElement('button', { type: 'button', 'data-toggle-decline': '', onClick: () => setDeclineClose(v => !v) }, 'Decline ' + declineClose),
              React.createElement('button', { type: 'button', 'data-open-related': '', onClick: () => setRelatedOpen(true) }, 'Open related'),
              React.createElement('button', { type: 'button', 'data-external-close': '', onClick: () => { setRelatedOpen(false); setSelected(null); } }, 'External close'),
              React.createElement('button', { type: 'button', 'data-rapid-reopen': '', onClick: () => {
                flushSync(() => { const btns = document.querySelectorAll('[data-pane="record"] header button'); btns[btns.length - 1]?.click(); });
                flushSync(() => setSelected('a'));
                outsideBtn.current?.focus();
              } }, 'Rapid reopen'),
              React.createElement(PaneGrid, {
                onSelect: handleSelect, onOpen: setOpened,
                main: React.createElement('div', null,
                  React.createElement('button', { ref: rowA, type: 'button', 'data-row-id': 'a', onClick: () => handleSelect('a') }, 'Row A'),
                  React.createElement('div', { ref: rowB, tabIndex: 0, role: 'button', 'data-row-id': 'b' }, 'Row B'),
                  React.createElement('div', { ref: rowC, tabIndex: 0, role: 'button', 'data-row-id': 'c' }, 'Row C'),
                  React.createElement('div', { tabIndex: 0, 'data-row-id': 'r1' },
                    React.createElement('input', { type: 'radio', name: 'rg', value: '1', defaultChecked: true, 'data-radio-1': '' }),
                    React.createElement('input', { type: 'radio', name: 'rg', value: '2', 'data-radio-2': '' }),
                    React.createElement('input', { type: 'checkbox', 'data-checkbox': '' }),
                  ),
                  React.createElement('div', { tabIndex: 0, 'data-row-id': 'r2' }, 'Row R2'),
                  React.createElement('div', { role: 'grid' }, React.createElement('div', { role: 'row', tabIndex: 0, 'data-row-id': 'g1' }, 'Grid Row')),
                ),
                record: selected ? {
                  id: selected, label: 'Record pane', title: 'Record ' + selected,
                  onClose: () => { if (!declineClose) { setRelatedOpen(false); setSelected(null); } },
                  returnFocus: () => { setRestoreCalls(c => c + 1); return selected === 'b' ? rowB.current : rowA.current; },
                  children: React.createElement('button', { type: 'button', 'data-inside-pane': '' }, 'Inside'),
                } : null,
                related: relatedOpen ? {
                  id: 'rel-1', label: 'Related pane', title: 'Related 1', onClose: () => setRelatedOpen(false),
                  children: React.createElement('button', { type: 'button', 'data-inside-related': '' }, 'Inside related'),
                } : null,
              }),
            );
          }
          createRoot(document.getElementById('root')).render(
            React.createElement(StrictMode, null, React.createElement(App)),
          );
        `
            : undefined,
      }],
    });
    await server.listen();
    browser = await browserEngine().launch();
    page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.route(`**/${slug}`, route =>
      route.fulfill({
        contentType: "text/html",
        body: `<html lang="ko"><title>${slug}</title><div id="root"></div><script type="module" src="/${slug}.js"></script></html>`,
      }),
    );
    await openBrowserTestPage(page, `${server.resolvedUrls!.local[0]}${slug}`, page.locator("[data-strict-pane-grid]"));
  }, 60_000);

  afterAll(async () => {
    await page?.close();
    await browser?.close();
    await server?.close();
  });

  const waitFrames = () => page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  const activeAttr = (attr: string) => page.evaluate(name => document.activeElement?.getAttribute(name) ?? null, attr);
  const hasActiveAttr = (attr: string) => page.evaluate(name => Boolean(document.activeElement?.hasAttribute(name)), attr);

  test("restores returnFocus in StrictMode, navigates non-grid rows with J/K/Enter, and avoids status-bar churn", async () => {
    await page.locator("[data-reset]").click();
    const rowB = page.locator('[data-row-id="b"]');
    const main = page.locator("[data-strict-pane-grid]");

    // 1. Inline status-bar array does not churn on parent re-renders
    const initialRenders = Number(await page.locator("[data-status-renders]").getAttribute("data-status-renders"));
    await page.locator("[data-rerender]").click();
    await page.locator("[data-rerender]").click();
    expect(Number(await page.locator("[data-status-renders]").getAttribute("data-status-renders"))).toBe(initialRenders);

    // 2. Non-grid row Enter selects first, then Enter again invokes onOpen; J/K and Arrow keys navigate rows
    await rowB.focus();
    await page.keyboard.press("Enter");
    await expect.poll(() => main.getAttribute("data-selected")).toBe("b");
    await expect.poll(() => main.getAttribute("data-opened")).toBe("");

    await page.keyboard.press("Enter");
    await expect.poll(() => main.getAttribute("data-opened")).toBe("b");

    await page.keyboard.press("k");
    await expect.poll(() => activeAttr("data-row-id")).toBe("a");
    await expect.poll(() => main.getAttribute("data-selected")).toBe("a");

    await page.keyboard.press("Enter");
    await expect.poll(() => main.getAttribute("data-opened")).toBe("a");

    await page.keyboard.press("ArrowDown");
    await expect.poll(() => activeAttr("data-row-id")).toBe("b");

    await page.keyboard.press("ArrowUp");
    await expect.poll(() => activeAttr("data-row-id")).toBe("a");
    await expect.poll(() => main.getAttribute("data-selected")).toBe("a");

    // 3. StrictMode Escape closes pane and restores returnFocus cleanly
    await page.locator("[data-inside-pane]").focus();
    await page.keyboard.press("Escape");
    await expect.poll(() => page.locator('[data-pane="record"]').count()).toBe(0);
    await expect.poll(() => activeAttr("data-row-id")).toBe("a");
  });

  test("does not restore stale returnFocus when onClose declines or depth rapidly reopens 1 -> 0 -> 1", async () => {
    await page.locator("[data-reset]").click();
    const main = page.locator("[data-strict-pane-grid]");

    // Declined onClose (1 -> 1) followed by opening related (1 -> 2)
    await page.locator('[data-row-id="a"]').click();
    await expect.poll(() => main.getAttribute("data-selected")).toBe("a");
    await page.locator("[data-toggle-decline]").click();
    await page.locator('[data-pane="record"] header button').last().click();
    await expect.poll(() => page.locator('[data-pane="record"]').count()).toBe(1);

    await page.locator("[data-outside]").focus();
    await page.locator("[data-open-related]").click();
    await expect.poll(() => page.locator('[data-pane="related"]').count()).toBe(1);
    await waitFrames();
    expect(await main.getAttribute("data-restore-calls")).toBe("0");
    expect(await activeAttr("data-row-id")).toBeNull();

    // Declined onClose (1 -> 1) followed by a later external programmatic close (1 -> 0)
    await page.locator("[data-reset]").click();
    await page.locator('[data-row-id="a"]').click();
    await expect.poll(() => main.getAttribute("data-selected")).toBe("a");
    await page.locator("[data-toggle-decline]").click();
    await page.locator('[data-pane="record"] header button').last().click();
    await waitFrames();
    await page.locator("[data-outside]").focus();
    await page.evaluate(() => (document.querySelector('[data-external-close]') as HTMLElement).click());
    await expect.poll(() => page.locator('[data-pane="record"]').count()).toBe(0);
    await waitFrames();
    expect(await main.getAttribute("data-restore-calls")).toBe("0");
    expect(await hasActiveAttr("data-outside")).toBe(true);

    // Rapid 1 -> 0 -> 1 before rAF fires
    await page.locator("[data-reset]").click();
    await page.locator('[data-row-id="a"]').click();
    await expect.poll(() => page.locator('[data-pane="record"]').count()).toBe(1);
    await page.locator("[data-rapid-reopen]").click();
    await waitFrames();
    expect(await main.getAttribute("data-restore-calls")).toBe("0");
    expect(await hasActiveAttr("data-outside")).toBe(true);
  });

  test("nested radio ArrowDown and checkbox j do not hijack row navigation", async () => {
    await page.locator("[data-reset]").click();
    const radio1 = page.locator("[data-radio-1]");
    await radio1.focus();
    await page.keyboard.press("ArrowDown");
    await expect.poll(() => page.evaluate(() => document.activeElement?.hasAttribute("data-radio-2"))).toBe(true);

    const checkbox = page.locator("[data-checkbox]");
    await checkbox.focus();
    await page.keyboard.press("j");
    await expect.poll(() => page.evaluate(() => document.activeElement?.hasAttribute("data-checkbox"))).toBe(true);
  });

  test("FOCUS_SETTLE_MS: rapid j, j skips intermediate row and calls onSelect once for the final settled row", async () => {
    await page.locator("[data-reset]").click();
    const main = page.locator("[data-strict-pane-grid]");
    await page.locator('[data-row-id="a"]').click();
    await expect.poll(() => main.getAttribute("data-select-log")).toBe("a");

    await page.locator('[data-row-id="a"]').focus();
    await page.keyboard.press("j");
    await page.keyboard.press("j");
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute("data-row-id"))).toBe("c");
    await expect.poll(() => main.getAttribute("data-select-log")).toBe("a,c");
  });

  test("1024px depth=2 hides the record splitter while keeping the related splitter visible and resizable", async () => {
    await page.locator("[data-reset]").click();
    try {
      await page.setViewportSize({ width: 1024, height: 900 });
      await page.locator('[data-row-id="a"]').click();
      await page.locator("[data-open-related]").click();
      await expect.poll(() => page.locator('[data-pane-grid]').getAttribute("data-depth")).toBe("2");

      const visibleSplitters = await page.evaluate(() =>
        [...document.querySelectorAll('[role="separator"]')].filter(el => getComputedStyle(el).display !== "none").length,
      );
      expect(visibleSplitters).toBe(1);

      const splitter = page.locator('[role="separator"]').last();
      const relatedPane = page.locator('[data-pane="related"]');
      const defaultWidth = await relatedPane.evaluate(el => el.getBoundingClientRect().width);
      await splitter.focus();
      await page.keyboard.press("ArrowLeft");
      await expect.poll(() => relatedPane.evaluate(el => el.getBoundingClientRect().width)).toBeGreaterThan(defaultWidth);

      for (let i = 0; i < 10; i++) await page.keyboard.press("ArrowLeft");
      expect(await splitter.getAttribute("aria-valuenow")).toBe("50");
      expect(await relatedPane.evaluate(el => el.getBoundingClientRect().width)).toBe(512);

      await page.keyboard.press("Home");
      await expect.poll(() => relatedPane.evaluate(el => el.getBoundingClientRect().width)).toBe(defaultWidth);
    } finally {
      await page.setViewportSize({ width: 1440, height: 900 });
    }
  });
});
