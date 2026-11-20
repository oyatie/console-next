// SPDX-License-Identifier: LicenseRef-Proprietary
import { afterAll, beforeAll, expect, test } from "vitest";
import { loadCatalog } from "@console/i18n";
import { mountBrowserModule, mountGalleryEntry, scanWcag22Matrix, type MountedGallery } from "../../lib/gallery-browser-test";

let mounted: MountedGallery;

beforeAll(async () => {
  await loadCatalog("ko");
  mounted = await mountGalleryEntry({
    name: "ledger",
    entryPath: "/apps/web/src/ui/ledger/ledger.gallery.tsx",
    readySelector: "[data-ledger-gallery]",
  });
}, 60_000);

afterAll(async () => {
  await mounted?.close();
});

test("Ledger passes WCAG 2.2 AA axe checks and matches Console desk/phone row geometry without overflow", async () => {
  const { page } = mounted;
  expect(await scanWcag22Matrix(page)).toEqual([]);

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => {
    document.documentElement.dataset.experience = "console";
    document.documentElement.dataset.theme = "light";
  });

  const deskMetrics = await page.evaluate(() => {
    const firstLedger = document.querySelector("[data-ledger]")!;
    const itemCell = firstLedger.querySelector("tbody th")!;
    const amountCell = firstLedger.querySelector("tbody td:last-child")!;
    return {
      rowHeight: itemCell.getBoundingClientRect().height,
      tabular: getComputedStyle(amountCell).fontVariantNumeric,
    };
  });
  expect(deskMetrics.rowHeight).toBeCloseTo(24, 0);
  expect(deskMetrics.tabular).toContain("tabular-nums");

  await page.setViewportSize({ width: 390, height: 844 });
  const phoneMetrics = await page.evaluate(() => {
    const inlineLedger = document.querySelector('[data-ledger][data-detail-layout="inline"]')!;
    const itemCell = inlineLedger.querySelector("tbody th")!;
    return {
      rowHeight: itemCell.getBoundingClientRect().height,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  expect(phoneMetrics.rowHeight).toBeCloseTo(40, 0);
  expect(phoneMetrics.overflow).toBe(0);
});

test("Ledger wraps long column labels at 390px, styles muted totals and negative notes, and clears aria-busy on error", async () => {
  const edgeMount = await mountBrowserModule({
    slug: "ledger-edge-test",
    readySelector: "[data-ledger-edge]",
    viewport: { width: 390, height: 844 },
    moduleCode: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { loadCatalog } from '@console/i18n';
      import '/apps/web/src/app.css';
      import { Ledger } from '/apps/web/src/ui/ledger/index';
      await loadCatalog('ko');
      document.documentElement.dataset.experience = 'console';
      document.documentElement.dataset.theme = 'light';
      createRoot(document.getElementById('root')).render(
        React.createElement('main', { 'data-ledger-edge': '' },
          React.createElement(Ledger, {
            title: 'Long column labels',
            detailLayout: 'column',
            rows: [
              { key: 'default', label: 'Regular item', detail: 'Basis', amount: '100,000' },
              { key: 'long', label: 'Very Long Allowance Name That Exceeds Narrow Viewport Width Easily', detail: 'Calculated monthly', amount: '250,000' },
            ],
            totals: [
              { key: 'mutedTot', label: 'Muted total', amount: '350,000', kind: 'total', tone: 'muted' },
              { key: 'negNote', label: 'Retroactive adjustment note', amount: '-12,000', kind: 'note', tone: 'negative' },
            ],
          }),
          React.createElement(Ledger, {
            title: 'Loading and error',
            loading: true,
            error: 'Gateway timeout',
            rows: [],
          })
        )
      );
    `,
  });

  try {
    const res = await edgeMount.page.evaluate(() => {
      const [mainLedger, errLedger] = [...document.querySelectorAll("[data-ledger]")];
      const table = mainLedger!.querySelector("table")!;
      const defaultRowAmount = mainLedger!.querySelector('tbody tr:first-child td:last-child')!;
      const mutedTotItem = mainLedger!.querySelector('tfoot tr[data-tone="muted"] th')!;
      const mutedTotAmount = mainLedger!.querySelector('tfoot tr[data-tone="muted"] td:last-child')!;
      const negNoteAmount = mainLedger!.querySelector('tfoot tr[data-kind="note"][data-tone="negative"] td:last-child')!;
      const probe = document.createElement("span");
      probe.style.color = "var(--steel)";
      document.body.appendChild(probe);
      const steelColor = getComputedStyle(probe).color;
      probe.style.color = "var(--danger-tx)";
      const dangerColor = getComputedStyle(probe).color;
      probe.remove();

      return {
        docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        tableOverflow: table.scrollWidth - table.clientWidth,
        defaultInk: getComputedStyle(defaultRowAmount).color,
        steelColor,
        dangerColor,
        mutedTotItemColor: getComputedStyle(mutedTotItem).color,
        mutedTotAmountColor: getComputedStyle(mutedTotAmount).color,
        negNoteAmountColor: getComputedStyle(negNoteAmount).color,
        errAriaBusy: errLedger!.getAttribute("aria-busy"),
        errHasAlert: Boolean(errLedger!.querySelector('[role="alert"]')),
      };
    });

    expect(res.docOverflow).toBe(0);
    expect(res.tableOverflow).toBe(0);
    expect(res.mutedTotItemColor).toBe(res.steelColor);
    expect(res.mutedTotAmountColor).toBe(res.steelColor);
    expect(res.mutedTotAmountColor).not.toBe(res.defaultInk);
    expect(res.negNoteAmountColor).toBe(res.dangerColor);
    expect(res.errAriaBusy).toBeNull();
    expect(res.errHasAlert).toBe(true);
  } finally {
    await edgeMount.close();
  }
});

test("Ledger wraps unbreakable tokens at 390px in inline and detail-less column layouts", async () => {
  const reflowMount = await mountBrowserModule({
    slug: "ledger-unbreakable-reflow-test",
    readySelector: "[data-ledger-unbreakable]",
    viewport: { width: 390, height: 844 },
    moduleCode: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { loadCatalog } from '@console/i18n';
      import '/apps/web/src/app.css';
      import { Ledger } from '/apps/web/src/ui/ledger/index';
      await loadCatalog('ko');
      document.documentElement.dataset.experience = 'console';
      document.documentElement.dataset.theme = 'light';
      const unbreakable = 'UNBREAKABLE_' + 'X'.repeat(80);
      createRoot(document.getElementById('root')).render(
        React.createElement('main', { 'data-ledger-unbreakable': '' },
          React.createElement(Ledger, {
            title: 'Inline unbreakable label',
            detailLayout: 'inline',
            rows: [
              { key: 'u1', label: unbreakable, detail: 'Inline basis', amount: '1,234,567' },
            ],
            totals: [
              { key: 't1', label: 'Total', amount: '1,234,567', kind: 'total' },
            ],
          }),
          React.createElement(Ledger, {
            title: 'Inline unbreakable detail',
            detailLayout: 'inline',
            rows: [
              { key: 'u2', label: 'Item', detail: unbreakable, amount: '1,234,567' },
            ],
            totals: [
              { key: 't2', label: 'Total', amount: '1,234,567', kind: 'total' },
            ],
          }),
          React.createElement(Ledger, {
            title: 'Column unbreakable without detail',
            detailLayout: 'column',
            rows: [
              { key: 'u3', label: unbreakable, amount: '1,234,567' },
            ],
            totals: [
              { key: 't3', label: 'Total', amount: '1,234,567', kind: 'total' },
            ],
          })
        )
      );
    `,
  });

  try {
    const res = await reflowMount.page.evaluate(() => {
      const ledgers = [...document.querySelectorAll("[data-ledger]")];
      return {
        docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        ledgers: ledgers.map(el => {
          const table = el.querySelector("table")!;
          return {
            layout: el.getAttribute("data-detail-layout"),
            hasDetailAttr: table.hasAttribute("data-has-detail"),
            tableOverflow: table.scrollWidth - table.clientWidth,
          };
        }),
      };
    });

    expect(res.docOverflow).toBe(0);
    expect(res.ledgers).toEqual([
      { layout: "inline", hasDetailAttr: false, tableOverflow: 0 },
      { layout: "inline", hasDetailAttr: false, tableOverflow: 0 },
      { layout: "column", hasDetailAttr: false, tableOverflow: 0 },
    ]);
  } finally {
    await reflowMount.close();
  }
});
