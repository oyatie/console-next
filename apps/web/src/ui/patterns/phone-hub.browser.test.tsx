// SPDX-License-Identifier: LicenseRef-Proprietary
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { mountBrowserModule, type MountedGallery } from "../../lib/gallery-browser-test";
import { expectFitsViewport, expectPatternMatrixClean, openPatternFixture } from "./pattern-browser-helpers";

let mounted: MountedGallery;

beforeAll(async () => {
  mounted = await openPatternFixture("phone-hub");
}, 60_000);

afterAll(async () => {
  await mounted?.close();
});

test("PhoneHub passes WCAG 2.2 AA matrix, keeps ISO date single-line, and contains SelectInput and Check at 390px and 320px", async () => {
  const { page } = mounted;
  await expectPatternMatrixClean(page);

  for (const width of [390, 320] as const) {
    await expectFitsViewport(page, width);
    const lineRects = await page.locator("dl").first().evaluate(dl => {
      const walker = document.createTreeWalker(dl, NodeFilter.SHOW_TEXT);
      let node: Node | null;
      while ((node = walker.nextNode())) {
        if (node.textContent?.includes("2019-03-14")) {
          const range = document.createRange();
          range.selectNodeContents(node);
          return range.getClientRects().length;
        }
      }
      return 0;
    });
    expect(lineRects).toBe(1);

    const bounds = await page.locator('[data-pattern="phone-hub"] select').evaluate(sel => {
      const s = sel.getBoundingClientRect();
      const c = sel.closest("section")!.getBoundingClientRect();
      return { selectRight: s.right, containerRight: c.right, selectLeft: s.left, containerLeft: c.left };
    });
    expect(bounds.selectLeft).toBeGreaterThanOrEqual(bounds.containerLeft);
    expect(bounds.selectRight).toBeLessThanOrEqual(bounds.containerRight + 0.5);
  }

  const check = page.locator('[data-pattern="phone-hub"] input[type="checkbox"]');
  const appearance = await check.evaluate(el => getComputedStyle(el).appearance);
  expect(appearance).toBe("none");
  expect(await check.isChecked()).toBe(true);
  await check.click();
  expect(await check.isChecked()).toBe(false);
}, 45_000);

describe("PhoneHub KeyValue label track containment with unspaced labels", () => {
  let longLabelApp: MountedGallery;

  beforeAll(async () => {
    longLabelApp = await mountBrowserModule({
      slug: "phone-hub-long-label",
      lang: "ko",
      readySelector: '[data-pattern="phone-hub"]',
      viewport: { width: 390, height: 844 },
      moduleCode: `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
        import { loadCatalog } from '@console/i18n';
        import { tg } from '@console/i18n/gallery';
        import { Check } from '/apps/web/src/ui/button/button.tsx';
        import { KeyValue } from '/apps/web/src/ui/key-value/key-value.tsx';
        import { PhoneHub } from '/apps/web/src/ui/patterns/phone-hub.tsx';
        import '/apps/web/src/app.css';

        await loadCatalog('ko');
        function App() {
          return React.createElement(PhoneHub, {
            q: { isPending: false, error: null, data: {}, refetch() {} },
            head: { title: 'My account' },
            sections: [{
              key: 'edit',
              title: 'Settings',
              children: React.createElement(KeyValue, {
                label: 'Settings',
                items: [{
                  key: 'notify',
                  label: tg('sample.longName').replace(/\\s+/g, ''),
                  value: React.createElement(Check, { checked: true, onChange: () => {} }, 'Notify'),
                }],
              }),
            }],
          });
        }
        const router = createRouter({ routeTree: createRootRoute({ component: App }), history: createMemoryHistory({ initialEntries: ['/'] }) });
        await router.load();
        createRoot(document.getElementById('root')).render(React.createElement(RouterProvider, { router }));
      `,
    });
  }, 60_000);

  afterAll(async () => {
    await longLabelApp?.close();
  });

  test("unspaced dt label wraps inside track and never collides with Check at 390px and 320px", async () => {
    const { page } = longLabelApp;
    for (const width of [390, 320] as const) {
      await page.setViewportSize({ width, height: 844 });
      const metrics = await page.locator("dl").evaluate(dl => {
        const dt = dl.querySelector("dt")!;
        const chk = dl.querySelector('input[type="checkbox"]')!;
        const dtRect = dt.getBoundingClientRect();
        const chkRect = chk.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(dt);
        const textRight = Math.max(...[...range.getClientRects()].map(r => r.right));
        return { dtRight: dtRect.right, textRight, chkLeft: chkRect.left };
      });
      expect(metrics.textRight).toBeLessThanOrEqual(metrics.dtRight + 0.5);
      expect(metrics.dtRight).toBeLessThanOrEqual(metrics.chkLeft + 0.5);
    }
  });
});
