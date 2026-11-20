// SPDX-License-Identifier: LicenseRef-Proprietary
import { readFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { renderToStaticMarkup as html } from "react-dom/server";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { loadCatalog } from "@console/i18n";
import { blocks } from "../../../../../scripts/check-standing-text.mjs";
import { browserEngine, browserTestOptimizeDeps, openBrowserTestPage, type Browser, type Page } from "../../lib/browser-test";
import { StatusBar } from "./status-bar";

beforeAll(async () => {
  await loadCatalog("ko");
});

test("StatusBar marks the first segment strong by default, supports attention and trailing slots, and omits aria-live", () => {
  const markup = html(
    <StatusBar
      label="Workspace status"
      segments={[
        { id: "scope", content: "All entities" },
        { id: "sync", content: "Synced" },
        { id: "overdue", content: "2 overdue", tone: "attention" },
      ]}
      trailing="Shortcuts ?"
    />,
  );
  expect(markup).toContain('<footer aria-label="Workspace status" data-surface="chrome"');
  expect(markup).toContain('data-tone="strong">All entities</div>');
  expect(markup).toContain('data-tone="default">Synced</div>');
  expect(markup).toContain('data-tone="attention">2 overdue</div>');
  expect(markup).toContain("Shortcuts ?");
  expect(markup).not.toContain("aria-live");
});

test("StatusBar renders nothing when empty and adds zero standing-text blocks", () => {
  expect(html(<StatusBar segments={[]} />)).toBe("");
  const source = readFileSync("apps/web/src/ui/status-bar/status-bar.tsx", "utf8");
  expect(blocks("apps/web/src/ui/status-bar/status-bar.tsx", source)).toBe(0);
});

describe("useScreenStatusBar", () => {
  const slug = "status-bar-store-test";
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
          import React, { createContext, StrictMode, useContext, useRef, useState } from 'react';
          import { createRoot } from 'react-dom/client';
          import { usePublishedStatusBar, useScreenStatusBar } from '/apps/web/src/ui/status-bar/status-bar-store.ts';

          const TickCtx = createContext(0);
          const SHARED_SEG = [{ id: 'shared', content: 'Shared segment' }];

          function JsxPublisher() {
            const tick = useContext(TickCtx);
            useScreenStatusBar([{ id: 'jsx', content: React.createElement('span', null, 'JSX') }]);
            return React.createElement('div', { 'data-jsx-tick': String(tick) });
          }

          function SharedPublisher({ id }) {
            useScreenStatusBar(SHARED_SEG);
            return React.createElement('span', { 'data-shared-pub': id });
          }

          function App() {
            const segments = usePublishedStatusBar();
            const [tick, setTick] = useState(0);
            const [mode, setMode] = useState('jsx');
            const [showA, setShowA] = useState(true);
            const [showB, setShowB] = useState(true);
            const renders = useRef(0);
            renders.current += 1;

            return React.createElement('main', {
              'data-status-ready': '',
              'data-renders': String(renders.current),
              'data-count': String(segments?.length ?? 0),
              'data-first-id': segments?.[0]?.id ?? '',
            },
              React.createElement('button', { type: 'button', 'data-bump': '', onClick: () => setTick(n => n + 1) }, 'Bump'),
              React.createElement('button', { type: 'button', 'data-mode-shared': '', onClick: () => setMode('shared') }, 'Shared mode'),
              React.createElement('button', { type: 'button', 'data-unmount-a': '', onClick: () => setShowA(false) }, 'Unmount A'),
              React.createElement('button', { type: 'button', 'data-unmount-b': '', onClick: () => setShowB(false) }, 'Unmount B'),
              mode === 'jsx'
                ? React.createElement(TickCtx.Provider, { value: tick }, React.createElement(JsxPublisher))
                : React.createElement(React.Fragment, null,
                    showA ? React.createElement(SharedPublisher, { id: 'a' }) : null,
                    showB ? React.createElement(SharedPublisher, { id: 'b' }) : null,
                  ),
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
    page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    await page.route(`**/${slug}`, route =>
      route.fulfill({
        contentType: "text/html",
        body: `<html lang="ko"><title>${slug}</title><div id="root"></div><script type="module" src="/${slug}.js"></script></html>`,
      }),
    );
    await openBrowserTestPage(page, `${server.resolvedUrls!.local[0]}${slug}`, page.locator("[data-status-ready]"));
  }, 60_000);

  afterAll(async () => {
    await page?.close();
    await browser?.close();
    await server?.close();
  });

  test("avoids re-render loops with inline JSX content under a context-providing subscriber and preserves SHARED_SEG across unmount", async () => {
    const main = page.locator("[data-status-ready]");
    await expect.poll(() => main.getAttribute("data-first-id")).toBe("jsx");
    const rendersAfterMount = Number(await main.getAttribute("data-renders"));

    // Re-rendering the context-providing subscriber passes a fresh <span>JSX</span> element; renders must stay bounded (no loop).
    await page.locator("[data-bump]").click();
    await expect.poll(() => page.locator("[data-jsx-tick]").getAttribute("data-jsx-tick")).toBe("1");
    const rendersAfterBump = Number(await main.getAttribute("data-renders"));
    expect(rendersAfterBump - rendersAfterMount).toBeLessThanOrEqual(2);

    // Switch to two publishers sharing the exact same SHARED_SEG constant reference.
    await page.locator("[data-mode-shared]").click();
    await expect.poll(() => main.getAttribute("data-first-id")).toBe("shared");
    expect(await main.getAttribute("data-count")).toBe("1");

    // Unmounting the first publisher must NOT clobber the surviving second publisher's status segments.
    await page.locator("[data-unmount-a]").click();
    await expect.poll(() => page.locator('[data-shared-pub="a"]').count()).toBe(0);
    expect(await main.getAttribute("data-count")).toBe("1");
    expect(await main.getAttribute("data-first-id")).toBe("shared");

    // Unmounting the last surviving publisher clears the status bar cleanly.
    await page.locator("[data-unmount-b]").click();
    await expect.poll(() => main.getAttribute("data-count")).toBe("0");
  });
});
