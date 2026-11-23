// SPDX-License-Identifier: LicenseRef-Proprietary
import { tg } from "@console/i18n/gallery";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { mountBrowserModule, type MountedGallery } from "../../lib/gallery-browser-test";
import { expectFitsViewport, expectPatternMatrixClean, openPatternFixture, setConsoleViewport } from "./pattern-browser-helpers";

let mounted: MountedGallery;

beforeAll(async () => {
  mounted = await openPatternFixture("form");
}, 60_000);

afterAll(async () => {
  await mounted?.close();
});

test("Form pattern passes WCAG 2.2 AA matrix, fits DateFields without clipping at 390px and 320px, and updates Meter/consequence", async () => {
  const { page } = mounted;
  await expectPatternMatrixClean(page);

  for (const width of [390, 320] as const) {
    await expectFitsViewport(page, width);
    const pairBoxes = await page.locator("input[type='text']").evaluateAll(els =>
      els.map(el => {
        const r = el.getBoundingClientRect();
        return {
          left: r.left,
          right: r.right,
          top: r.top,
          bottom: r.bottom,
          scrollWidth: el.scrollWidth,
          clientWidth: el.clientWidth,
        };
      }),
    );
    expect(pairBoxes).toHaveLength(2);
    for (const box of pairBoxes) {
      expect(box.scrollWidth).toBeLessThanOrEqual(box.clientWidth);
      expect(box.right).toBeLessThanOrEqual(width);
    }
    if (width === 390) {
      expect(pairBoxes[0]!.right).toBeLessThanOrEqual(pairBoxes[1]!.left);
    } else {
      expect(pairBoxes[0]!.bottom).toBeLessThanOrEqual(pairBoxes[1]!.top);
    }
  }

  await page.getByText(tg("pat.form.halfAm")).click();
  expect(await page.locator('[role="meter"]').getAttribute("aria-valuetext")).toMatch(/5\.5/);
  expect(await page.locator("button[type='submit']").getAttribute("data-submitted")).toBe("0");
  await page.locator("button[type='submit']").click();
  expect(await page.locator("button[type='submit']").getAttribute("data-submitted")).toBe("1");

  // Standalone 320x844 Console check: ActionBar flows below Reason textarea and never overlaps on initial render or focus.
  await setConsoleViewport(page, 320, 844);
  const readStandalone = () =>
    page.evaluate(() => {
      const ta = document.querySelector<HTMLTextAreaElement>("textarea")!;
      const bar = document.querySelector<HTMLElement>("[data-pattern='form'] [data-sticky]")!;
      const taRect = ta.getBoundingClientRect();
      const barRect = bar.getBoundingClientRect();
      const hit = document.elementFromPoint(taRect.left + taRect.width / 2, taRect.bottom - 8);
      return {
        taBottom: taRect.bottom,
        barTop: barRect.top,
        barPosition: getComputedStyle(bar).position,
        hitTag: hit?.tagName ?? null,
      };
    });
  const beforeFocus = await readStandalone();
  expect(beforeFocus.barPosition).toBe("static");
  expect(beforeFocus.taBottom).toBeLessThanOrEqual(beforeFocus.barTop + 0.5);
  expect(beforeFocus.hitTag).toBe("TEXTAREA");
  await page.locator("textarea").focus();
  const afterFocus = await readStandalone();
  expect(afterFocus.taBottom).toBeLessThanOrEqual(afterFocus.barTop + 0.5);
  expect(afterFocus.hitTag).toBe("TEXTAREA");
}, 45_000);

describe("Form phone ActionBar non-overlap inside 735px ConsoleShell main container", () => {
  let shellApp: MountedGallery;

  beforeAll(async () => {
    shellApp = await mountBrowserModule({
      slug: "form-phone-shell-container",
      lang: "ko",
      readySelector: '[data-pattern="form"] textarea',
      viewport: { width: 390, height: 844 },
      moduleCode: `
        import React, { useState } from 'react';
        import { createRoot } from 'react-dom/client';
        import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
        import { loadCatalog } from '@console/i18n';
        import { PagePhoneHeader } from '/apps/web/src/ui/page/page-scope.ts';
        import FormExample from '/apps/web/src/ui/patterns/form.fixture.tsx';
        import '/apps/web/src/app.css';

        await loadCatalog('ko');
        document.documentElement.dataset.experience = 'console';
        document.documentElement.dataset.theme = 'light';

        function ShellHarness() {
          const [owns, setOwns] = useState(false);
          return React.createElement(
            PagePhoneHeader.Provider,
            { value: { shellOwnsH1: owns } },
            React.createElement(
              'div',
              {
                style: {
                  display: 'grid',
                  gridTemplateRows: '52px 735px 56px',
                  height: '844px',
                  width: '100%',
                },
              },
              React.createElement(
                'header',
                { style: { display: 'flex', alignItems: 'center' } },
                React.createElement(
                  'button',
                  { type: 'button', 'data-toggle-owns': '', onClick: () => setOwns(v => !v) },
                  owns ? 'owns1' : 'owns0',
                ),
              ),
              React.createElement(
                'div',
                { id: 'main', style: { height: '735px', overflowY: 'auto', position: 'relative' } },
                React.createElement(FormExample),
              ),
              React.createElement('nav', { 'aria-label': 'Bottom', style: { height: '56px' } }),
            ),
          );
        }

        const router = createRouter({
          routeTree: createRootRoute({ component: ShellHarness }),
          history: createMemoryHistory({ initialEntries: ['/'] }),
        });
        await router.load();
        createRoot(document.getElementById('root')).render(React.createElement(RouterProvider, { router }));
      `,
    });
  }, 60_000);

  afterAll(async () => {
    await shellApp?.close();
  });

  test("Reason textarea stays above ActionBar on initial render and after focus at 390x844 and 320x844 for shellOwnsH1 false and true", async () => {
    const { page } = shellApp;
    const toggle = page.locator("[data-toggle-owns]");

    for (const width of [390, 320] as const) {
      await page.setViewportSize({ width, height: 844 });
      for (const owns of [false, true] as const) {
        const current = await toggle.textContent();
        if ((owns && current !== "owns1") || (!owns && current !== "owns0")) {
          await toggle.click();
        }
        await page.evaluate(() => {
          document.getElementById("main")!.scrollTop = 0;
        });

        const probe = () =>
          page.evaluate(() => {
            const main = document.getElementById("main")!;
            const ta = main.querySelector<HTMLTextAreaElement>("textarea")!;
            const bar = main.querySelector<HTMLElement>("[data-sticky]")!;
            const taRect = ta.getBoundingClientRect();
            const barRect = bar.getBoundingClientRect();
            const hit = document.elementFromPoint(taRect.left + taRect.width / 2, taRect.bottom - 8);
            return {
              taBottom: taRect.bottom,
              barTop: barRect.top,
              barPosition: getComputedStyle(bar).position,
              hitTag: hit?.tagName ?? null,
              docOverflow: document.documentElement.scrollWidth - window.innerWidth,
            };
          });

        const initial = await probe();
        expect(initial.docOverflow).toBeLessThanOrEqual(0);
        expect(initial.barPosition).toBe("static");
        expect(initial.taBottom).toBeLessThanOrEqual(initial.barTop + 0.5);
        expect(initial.hitTag).toBe("TEXTAREA");

        await page.locator("#main textarea").focus();
        const afterFocus = await probe();
        expect(afterFocus.taBottom).toBeLessThanOrEqual(afterFocus.barTop + 0.5);
        expect(afterFocus.hitTag).toBe("TEXTAREA");
      }
    }
  }, 45_000);
});
