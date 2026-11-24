// SPDX-License-Identifier: LicenseRef-Proprietary
import { afterAll, beforeAll, expect, test } from "vitest";
import { mountBrowserModule, type MountedGallery } from "../../lib/gallery-browser-test";

let mounted: MountedGallery;

beforeAll(async () => {
  mounted = await mountBrowserModule({
    slug: "pane-grid-focus-race-test",
    viewport: { width: 1440, height: 900 },
    readySelector: "[data-focus-race-grid]",
    moduleCode: `
      import React, { StrictMode, useRef, useState } from 'react';
      import { createRoot } from 'react-dom/client';
      import { loadCatalog } from '@console/i18n';
      import { PaneGrid } from '/apps/web/src/ui/pane-grid/pane-grid.tsx';
      import { TreeView } from '/apps/web/src/ui/tree/tree.tsx';
      import '/apps/web/src/app.css';
      await loadCatalog('ko');
      function App() {
        const [selected, setSelected] = useState(null);
        const [restoreCalls, setRestoreCalls] = useState(0);
        const rowA = useRef(null), rowB = useRef(null);
        return React.createElement('main', { 'data-focus-race-grid': '', 'data-restore-calls': String(restoreCalls) },
          React.createElement('button', { type: 'button', 'data-outside': '' }, 'Outside'),
          React.createElement('button', { type: 'button', 'data-reset': '', onClick: () => { setSelected(null); setRestoreCalls(0); } }, 'Reset'),
          React.createElement(PaneGrid, {
            onSelect: setSelected,
            main: React.createElement('div', null,
              React.createElement('button', { ref: rowA, type: 'button', 'data-row-id': 'a', onClick: () => setSelected('a') }, 'Row A'),
              React.createElement('button', { ref: rowB, type: 'button', 'data-row-id': 'b' }, 'Row B'),
            ),
            record: selected ? {
              id: selected, label: 'Record pane', title: 'Record ' + selected,
              onClose: () => setSelected(null),
              returnFocus: () => { setRestoreCalls(c => c + 1); return rowA.current; },
              children: React.createElement('div', null,
                React.createElement('button', { type: 'button', 'data-inside-pane': '' }, 'Inside'),
                React.createElement('button', { type: 'button', 'aria-haspopup': 'listbox', 'aria-expanded': 'true' }, 'Open select'),
                React.createElement(TreeView, {
                  label: 'Units', roots: [{ id: 'Head office', children: [{ id: 'Sales', children: [] }] }], childrenOf: u => u.children,
                  textValue: u => u.id, row: u => u.id, onSelect: () => {}, required: true, expanded: new Set(['Head office']), onExpandedChange: () => {},
                }),
              ),
            } : null,
          }),
        );
      }
      createRoot(document.getElementById('root')).render(React.createElement(StrictMode, null, React.createElement(App)));
    `,
  });
}, 60_000);

afterAll(async () => {
  await mounted?.close();
});

test("PaneGrid rAF returnFocus preserves intentional focus moved before rAF and still restores when focus fell to body", async () => {
  const { page } = mounted;
  const main = page.locator("[data-focus-race-grid]");

  const moveBeforeRaf = (startSel: string, nextSel: string) =>
    page.evaluate(
      ([start, next]) =>
        new Promise<string | null>(resolve => {
          const trigger = document.querySelector<HTMLElement>(start);
          const target = document.querySelector<HTMLElement>(next);
          trigger?.focus();
          const obs = new MutationObserver(() => {
            if (!document.querySelector('[data-pane="record"]')) {
              obs.disconnect();
              target?.focus();
              requestAnimationFrame(() =>
                requestAnimationFrame(() => {
                  const active = document.activeElement;
                  resolve(active?.getAttribute("data-row-id") ?? (active?.hasAttribute("data-outside") ? "outside" : active?.tagName ?? null));
                }),
              );
            }
          });
          obs.observe(document.body, { childList: true, subtree: true });
          trigger?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
        }),
      [startSel, nextSel] as const,
    );

  // Case 1: focus stayed in center (outside closing pane) and moves to row B before rAF fires
  await page.locator('[data-row-id="a"]').click();
  await page.locator('[data-pane="record"]').waitFor();
  expect(await moveBeforeRaf('[data-row-id="a"]', '[data-row-id="b"]')).toBe("b");
  expect(await main.getAttribute("data-restore-calls")).toBe("0");

  // Case 2: focus was inside closing pane (falls back to body on unmount) and moves outside before rAF fires
  await page.locator("[data-reset]").click();
  await page.locator('[data-row-id="a"]').click();
  await page.locator('[data-pane="record"]').waitFor();
  expect(await moveBeforeRaf("[data-inside-pane]", "[data-outside]")).toBe("outside");
  expect(await main.getAttribute("data-restore-calls")).toBe("0");

  // Case 3: focus was inside closing pane and stays lost on body -> returnFocus restores row A
  await page.locator("[data-reset]").click();
  await page.locator('[data-row-id="a"]').click();
  await page.locator('[data-pane="record"]').waitFor();
  await page.locator("[data-inside-pane]").focus();
  await page.keyboard.press("Escape");
  await expect.poll(() => page.locator('[data-pane="record"]').count()).toBe(0);
  await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute("data-row-id") ?? null)).toBe("a");
  expect(await main.getAttribute("data-restore-calls")).toBe("1");
});

test("Escape from an unfolded tree row closes the record pane, and an open select keeps it", async () => {
  const { page } = mounted;
  await page.locator("[data-reset]").click();
  await page.locator('[data-row-id="a"]').click();
  const record = page.locator('[data-pane="record"]');
  await page.getByRole("button", { name: "Open select", exact: true }).press("Escape");
  await expect.poll(() => record.count()).toBe(1);
  const unfolded = page.getByRole("row", { name: "Head office", exact: true });
  expect(await unfolded.getAttribute("aria-expanded")).toBe("true");
  await unfolded.press("Escape");
  await expect.poll(() => record.count()).toBe(0);
});
