// SPDX-License-Identifier: LicenseRef-Proprietary
import { afterAll, beforeAll, expect, test } from "vitest";
import { mountBrowserModule, type MountedGallery } from "../../lib/gallery-browser-test";

let mounted: MountedGallery;

beforeAll(async () => {
  mounted = await mountBrowserModule({
    slug: "long-table-phone-targets",
    readySelector: '[aria-label="Compact"] [data-row-id="A"]',
    viewport: { width: 390, height: 844 },
    // The row controls the org list, the exits list, statutory filings and the roster put in a cell: the selection
    // checkbox, a ghost button, a small action button and a name link. "Cards" is the default phone layout, and
    // "Compact" the 2-line row the exits list and statutory filings use. "No tail" is a compact row without status and
    // actions, and "One line" one without facts and with a plain-text name.
    moduleCode: `
      import { createElement as h, useState } from 'react';
      import { createRoot } from 'react-dom/client';
      import { loadCatalog } from '@console/i18n';
      import { LongTable } from '/apps/web/src/ui/long-table/long-table.tsx';
      import { Button } from '/apps/web/src/ui/button/button.tsx';
      import '/apps/web/src/app.css';
      await loadCatalog('ko');
      document.documentElement.dataset.theme = 'light';
      const rows = ['A', 'B', 'C'].map(id => ({ id }));
      const columns = [
        { id: 'name', header: 'Name', rowHeader: true, card: 'title', width: 200,
          cell: r => h('span', { style: { display: 'flex', alignItems: 'center' } }, h('a', { href: '#' + r.id, 'data-k': 'link' }, 'Person ' + r.id)) },
        { id: 'unit', header: 'Unit', card: 'fact', width: 120, cell: () => h('span', { 'data-k': 'fact' }, 'Unit') },
        { id: 'fold', header: 'Fold', card: 'status', width: 120, cell: r => h(Button, { variant: 'ghost', 'data-k': 'ghost', 'aria-label': 'Fold ' + r.id }, '-') },
        { id: 'open', header: 'Open', card: 'action', width: 120, cell: r => h(Button, { size: 'sm', 'data-k': 'action' }, 'Open ' + r.id) },
      ];
      function Table({ label, compact, shown = columns }) {
        const [selection, setSelection] = useState({ kind: 'ids', ids: new Set() });
        return h(LongTable, { label, rows, columns: shown, rowId: r => r.id, hasMore: false, onLoadMore: () => {}, empty: 'None',
          selection, onSelectionChange: setSelection, ...(compact ? { density: 'compact', mobileLayout: 'compact' } : {}) });
      }
      createRoot(document.getElementById('root')).render(h('main', null, h(Table, { label: 'Cards' }), h(Table, { label: 'Compact', compact: true }),
        h(Table, { label: 'No tail', compact: true, shown: columns.slice(0, 2) }),
        h(Table, { label: 'One line', compact: true, shown: [{ ...columns[0], cell: r => 'Person ' + r.id }, columns[2], columns[3]] })));
      // A table a test mounts later, to watch its first frames.
      const late = document.body.appendChild(document.createElement('section'));
      window.mountLate = () => createRoot(late).render(h(Table, { label: 'Late', compact: true }));
    `,
  });
}, 60_000);

afterAll(async () => {
  await mounted?.close();
});

type Box = { width: number; height: number };
type Table = "Cards" | "Compact";

/**
 * The box a pointer can hit for each control of row A, as far as its cell shows it (a checkbox is hit through its
 * label), the header's and the row's heights, and how many of the row's cells clip what they hold.
 */
async function targets(table: Table, style: string, width: number, layout: "cards" | "rows") {
  const { page } = mounted;
  await page.evaluate(s => { document.documentElement.dataset.experience = s; }, style);
  await page.setViewportSize({ width, height: width < 768 ? 844 : 900 });
  const grid = page.getByRole("grid", { name: table, exact: true });
  await expect.poll(() => grid.getAttribute("data-layout")).toBe(layout);
  // Card heights settle a frame after the layout flips.
  await page.evaluate(() => new Promise(requestAnimationFrame));
  await page.evaluate(() => new Promise(requestAnimationFrame));
  return grid.evaluate(el => {
    const row = el.querySelector('[data-row-id="A"]')!;
    const box = (target: Element | null): Box => {
      const r = target!.getBoundingClientRect();
      const c = target!.closest('[role="rowheader"], [role="gridcell"], [role="columnheader"]')!.getBoundingClientRect();
      const span = (start: number, end: number, from: number, to: number) => Math.round(Math.min(end, to) - Math.max(start, from));
      return { width: span(r.left, r.right, c.left, c.right), height: span(r.top, r.bottom, c.top, c.bottom) };
    };
    const cells = [...row.querySelectorAll('[role="rowheader"], [role="gridcell"]')];
    return {
      boxes: {
        select: box(row.querySelector('input[type="checkbox"]')!.closest("label")),
        selectAll: box(el.querySelector('[role="columnheader"] input[type="checkbox"]')!.closest("label")),
        link: box(row.querySelector('[data-k="link"]')),
        ghost: box(row.querySelector('[data-k="ghost"]')),
        action: box(row.querySelector('[data-k="action"]')),
      },
      head: Math.round(el.querySelector('[role="columnheader"]')!.getBoundingClientRect().height),
      row: Math.max(...cells.map(cell => Math.round(cell.getBoundingClientRect().height))),
      scrollTargetHeight: Math.round(row.getBoundingClientRect().height),
      clipped: cells.filter(cell => cell.scrollHeight > cell.clientHeight + 1).length,
    };
  });
}

const short = (boxes: Record<string, Box>, skip: string[] = []) =>
  Object.entries(boxes).filter(([k, b]) => !skip.includes(k) && Math.min(b.width, b.height) < 44).map(([k]) => k);
const heights = (boxes: Record<string, Box>) => Object.fromEntries(Object.entries(boxes).map(([k, b]) => [k, b.height]));
const DESK = { select: 24, selectAll: 24, link: 24, ghost: 24, action: 24 };
// The header heights the table lays out for regular and compact density.
const HEAD = { Cards: 40, Compact: 36 };

test.each(["cards", "rows"] as const)("virtual row scroll bounds cover the cells in the %s layout", async layout => {
  const { row, scrollTargetHeight } = await targets("Cards", "baseline", layout === "cards" ? 390 : 1440, layout);
  expect(scrollTargetHeight).toBeGreaterThanOrEqual(row);
});

test("in Console a phone card row keeps 44px touch targets for its checkbox, buttons and name link, as cards and as rows", async () => {
  for (const [width, layout] of [[390, "cards"], [700, "rows"]] as const) {
    const { boxes, clipped } = await targets("Cards", "console", width, layout);
    expect(short(boxes), `${width}px`).toEqual([]);
    expect(clipped, `${width}px`).toBe(0);
  }
}, 30_000);

test("in Console a phone compact row keeps 44px touch targets for its checkbox and buttons within its 2-line height", async () => {
  const { boxes, row, clipped } = await targets("Compact", "console", 390, "cards");
  expect(short(boxes, ["link"])).toEqual([]);
  expect(row).toBeLessThanOrEqual(68);
  expect(clipped).toBe(0);
}, 30_000);

test("in Console a phone compact row keeps its fact line under the name, and a 1-line row keeps the name level with its actions", async () => {
  const { page } = mounted;
  await targets("Compact", "console", 390, "cards");
  const place = (table: string) => page.getByRole("grid", { name: table, exact: true }).evaluate(el => {
    const row = el.querySelector('[data-row-id="A"]')!;
    const rect = (selector: string) => {
      const r = row.querySelector(selector)?.getBoundingClientRect();
      return r && { left: Math.round(r.left), top: Math.round(r.top), bottom: Math.round(r.bottom), middle: Math.round((r.top + r.bottom) / 2) };
    };
    return { name: rect('[id$="-title"]')!, fact: rect('[data-k="fact"]'), action: rect('[data-k="action"]') };
  });
  for (const table of ["Compact", "No tail"]) {
    const { name, fact } = await place(table);
    expect(fact!.top, table).toBeGreaterThanOrEqual(name.bottom);
    expect(fact!.left, table).toBe(name.left);
  }
  const { name, action } = await place("One line");
  expect(Math.abs(name.middle - action!.middle)).toBeLessThanOrEqual(1);
}, 30_000);

// The rows sit under the header, so a header that grows after its first frame moves every row and its controls.
test("in Console a phone table draws its header at the select-all checkbox's height from its first frame", async () => {
  const { page } = mounted;
  await targets("Compact", "console", 390, "cards");
  const drawn = await page.evaluate(() => new Promise<number[]>(resolve => {
    const seen: number[] = [];
    const start = performance.now();
    const tick = () => {
      const head = document.querySelector('[aria-label="Late"] [role="columnheader"]');
      if (head) {
        const height = Math.round(head.getBoundingClientRect().height);
        if (seen.at(-1) !== height) seen.push(height);
      }
      if (seen.length && performance.now() - start > 500) resolve(seen);
      else requestAnimationFrame(tick);
    };
    (window as unknown as { mountLate: () => void }).mountLate();
    requestAnimationFrame(tick);
  }));
  expect(drawn).toEqual([45]);
}, 30_000);

test("in Console a phone compact-density row clips none of its controls", async () => {
  const { clipped } = await targets("Compact", "console", 700, "rows");
  expect(clipped).toBe(0);
}, 30_000);

test("in Console at the desk the row controls stay 24px tall and the checkbox 24px square", async () => {
  for (const table of ["Cards", "Compact"] as const) {
    const { boxes, head } = await targets(table, "console", 1440, "rows");
    expect(heights(boxes), table).toEqual(DESK);
    expect(boxes.select.width, table).toBe(24);
    expect(head, table).toBe(HEAD[table]);
  }
}, 30_000);

test("in Classic the row controls keep their sizes on a phone and at the desk", async () => {
  for (const table of ["Cards", "Compact"] as const) for (const [width, layout] of [[390, "cards"], [1440, "rows"]] as const) {
    const { boxes, head } = await targets(table, "baseline", width, layout);
    expect(heights(boxes), `${table} ${width}px`).toEqual(DESK);
    expect(boxes.select.width, `${table} ${width}px`).toBe(24);
    expect(head, `${table} ${width}px`).toBe(HEAD[table]);
  }
}, 30_000);

