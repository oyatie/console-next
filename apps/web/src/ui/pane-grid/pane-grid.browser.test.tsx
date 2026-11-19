// SPDX-License-Identifier: LicenseRef-Proprietary
import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createServer, type ViteDevServer } from "vite";
import { loadCatalog, t } from "@console/i18n";
import { afterAll, beforeAll, expect, test } from "vitest";
import { browserEngine, browserTestOptimizeDeps, openBrowserTestPage } from "../../lib/browser-test";
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

test("PaneGrid restores returnFocus in StrictMode, navigates non-grid rows with J/K/Enter, and avoids status-bar churn", async () => {
  const slug = "pane-grid-strict-test";
  const server: ViteDevServer = await createServer({
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
      resolveId: id => id === `/${slug}.js` ? `\0${slug}` : undefined,
      load: id => id === `\0${slug}` ? `
        import React, { StrictMode, useRef, useState } from 'react';
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
          const [selected, setSelected] = useState(null);
          const [opened, setOpened] = useState('');
          const rowA = useRef(null);
          const rowB = useRef(null);
          return React.createElement('main', { 'data-strict-pane-grid': '', 'data-opened': opened, 'data-selected': selected ?? '' },
            React.createElement(StatusSubscriber),
            React.createElement(StatusPublisher),
            React.createElement(PaneGrid, {
              onSelect: setSelected,
              onOpen: setOpened,
              main: React.createElement('div', null,
                React.createElement('button', { ref: rowA, type: 'button', 'data-row-id': 'a', onClick: () => setSelected('a') }, 'Row A'),
                React.createElement('div', { ref: rowB, tabIndex: 0, role: 'button', 'data-row-id': 'b' }, 'Row B'),
                React.createElement('div', { role: 'grid' },
                  React.createElement('div', { role: 'row', tabIndex: 0, 'data-row-id': 'g1' }, 'Grid Row'),
                ),
              ),
              record: selected ? {
                id: selected,
                label: 'Record pane',
                title: 'Record ' + selected,
                onClose: () => setSelected(null),
                returnFocus: () => (selected === 'b' ? rowB.current : rowA.current),
                children: React.createElement('button', { type: 'button', 'data-inside-pane': '' }, 'Inside'),
              } : null,
            }),
          );
        }
        createRoot(document.getElementById('root')).render(
          React.createElement(StrictMode, null, React.createElement(App)),
        );
      ` : undefined,
    }],
  });
  await server.listen();
  const browser = await browserEngine().launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await page.route(`**/${slug}`, route => route.fulfill({
      contentType: "text/html",
      body: `<html lang="ko"><title>${slug}</title><div id="root"></div><script type="module" src="/${slug}.js"></script></html>`,
    }));
    await openBrowserTestPage(page, `${server.resolvedUrls!.local[0]}${slug}`, page.locator("[data-strict-pane-grid]"));

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
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute("data-row-id"))).toBe("a");
    await expect.poll(() => main.getAttribute("data-selected")).toBe("a");

    await page.keyboard.press("Enter");
    await expect.poll(() => main.getAttribute("data-opened")).toBe("a");

    await page.keyboard.press("ArrowDown");
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute("data-row-id"))).toBe("b");

    await page.keyboard.press("ArrowUp");
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute("data-row-id"))).toBe("a");
    await expect.poll(() => main.getAttribute("data-selected")).toBe("a");

    // 3. StrictMode Escape closes pane and restores returnFocus cleanly
    await page.locator("[data-inside-pane]").focus();
    await page.keyboard.press("Escape");
    await expect.poll(() => page.locator('[data-pane="record"]').count()).toBe(0);
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute("data-row-id"))).toBe("a");
  } finally {
    await page.close();
    await browser.close();
    await server.close();
  }
}, 60_000);
