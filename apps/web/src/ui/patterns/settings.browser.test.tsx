// SPDX-License-Identifier: LicenseRef-Proprietary
import { tg } from "@console/i18n/gallery";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { mountBrowserModule, type MountedGallery } from "../../lib/gallery-browser-test";
import { expectFitsViewport, expectPatternMatrixClean, openPatternFixture, setConsoleViewport } from "./pattern-browser-helpers";

let mounted: MountedGallery;

beforeAll(async () => {
  mounted = await openPatternFixture("settings");
}, 60_000);

afterAll(async () => {
  await mounted?.close();
});

test("Settings pattern passes WCAG 2.2 AA matrix, fits 390px and 320px, switches category rail, and restores focus on Escape", async () => {
  const { page } = mounted;
  await expectPatternMatrixClean(page);
  await expectFitsViewport(page, 320);

  await setConsoleViewport(page, 1440, 900);
  const domainNav = page.getByRole("navigation", { name: tg("pat.settings.navLabel") }).getByRole("button", { name: tg("pat.settings.catDomain") });
  await domainNav.click();
  expect(await domainNav.getAttribute("aria-current")).toBe("page");

  const inspectBtn = page.locator("#settings-inspect-btn");
  await inspectBtn.click();
  const pane = page.locator('[data-pane="record"]');
  await pane.waitFor();
  await pane.getByRole("button").first().focus();
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector('[data-pane="record"]'));
  expect(await inspectBtn.evaluate(el => document.activeElement === el)).toBe(true);
}, 45_000);

describe("Settings keeps data-detail cleared across ok -> 403 -> pending", () => {
  let phoneApp: MountedGallery;

  beforeAll(async () => {
    phoneApp = await mountBrowserModule({
      slug: "settings-keepprev-403",
      lang: "en",
      readySelector: '[data-pattern="settings"] [data-pane="record"]',
      viewport: { width: 390, height: 844 },
      moduleCode: `
        import React, { useState } from 'react';
        import { createRoot } from 'react-dom/client';
        import { QueryClient, QueryClientProvider, keepPreviousData, useQuery } from '@tanstack/react-query';
        import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
        import { ApiError } from '@console/api';
        import { loadCatalog } from '@console/i18n';
        import { SettingsPattern } from '/apps/web/src/ui/patterns/settings.tsx';
        import { read } from '/apps/web/src/lib/query.ts';
        import '/apps/web/src/app.css';

        await loadCatalog('en');
        const settingsClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

        function SettingsRefusalProbe() {
          const [step, setStep] = useState('ok');
          const readState = useQuery({
            ...read('/api/v1/settings-keepprev', () => {
              if (step === '403') return Promise.reject(new ApiError(403, 'access_denied', '', [], 'op-settings-403'));
              if (step === 'pending') return new Promise(() => {});
              return Promise.resolve({ items: [] });
            }, step),
            placeholderData: keepPreviousData,
          });
          return React.createElement('div', null,
            React.createElement('div', { 'data-controls': '' },
              React.createElement('button', { type: 'button', id: 'set-refuse', onClick: () => setStep('403') }, '403'),
              React.createElement('button', { type: 'button', id: 'set-wait', onClick: () => setStep('pending') }, 'wait'),
            ),
            React.createElement(SettingsPattern, {
              q: readState,
              head: { title: 'Settings', titleId: 'settings-h1' },
              views: React.createElement('nav', { 'aria-label': 'Categories' }, 'Nav'),
              panel: React.createElement('section', null, 'Settings body'),
              record: { id: 'pol', label: 'Policy history', onClose: () => undefined, children: React.createElement('div', null, 'History') },
            }),
          );
        }
        const appRouter = createRouter({ routeTree: createRootRoute({ component: SettingsRefusalProbe }), history: createMemoryHistory({ initialEntries: ['/'] }) });
        await appRouter.load();
        createRoot(document.getElementById('root')).render(React.createElement(QueryClientProvider, { client: settingsClient }, React.createElement(RouterProvider, { router: appRouter })));
      `,
    });
  }, 60_000);

  afterAll(async () => {
    await phoneApp?.close();
  });

  test("restores visible h1 and clears data-detail across ok -> 403 -> pending", async () => {
    const { page } = phoneApp;
    const pattern = page.locator('[data-pattern="settings"]');
    const heading = page.locator("#settings-h1");
    expect(await pattern.getAttribute("data-detail")).toBe("true");
    expect((await heading.boundingBox())?.height ?? 0).toBe(0);

    await page.locator("#set-refuse").click();
    await page.getByText("op-settings-403").waitFor();
    expect(await pattern.getAttribute("data-detail")).toBeNull();
    expect((await heading.boundingBox())?.height ?? 0).toBeGreaterThan(0);

    await page.locator("#set-wait").click();
    await page.waitForTimeout(50);
    expect(await pattern.getAttribute("data-detail")).toBeNull();
    expect(await page.locator('[data-pane="record"]').count()).toBe(0);
    expect((await heading.boundingBox())?.height ?? 0).toBeGreaterThan(0);
  });
});
