// SPDX-License-Identifier: LicenseRef-Proprietary
import { afterAll, beforeAll, expect, test } from "vitest";
import { mountBrowserModule, type MountedGallery } from "../../lib/gallery-browser-test";

let mounted: MountedGallery;

beforeAll(async () => {
  mounted = await mountBrowserModule({
    slug: "long-table-row-states",
    readySelector: '[data-row-id="C"]',
    viewport: { width: 1440, height: 900 },
    // A is plain, B is checked, C is open.
    moduleCode: `
      import { createElement as h, useState } from 'react';
      import { createRoot } from 'react-dom/client';
      import { loadCatalog } from '@console/i18n';
      import { LongTable } from '/apps/web/src/ui/long-table/long-table.tsx';
      import '/apps/web/src/app.css';
      await loadCatalog('ko');
      document.documentElement.dataset.experience = new URLSearchParams(location.search).get('style') ?? 'console';
      document.documentElement.dataset.theme = 'light';
      const rows = ['A', 'B', 'C'].map(id => ({ id }));
      const columns = [{ id: 'name', header: 'Name', rowHeader: true, cell: r => r.id, width: 200 }, { id: 'unit', header: 'Unit', cell: () => 'Unit', width: 200 }];
      function Harness() {
        const [selection, setSelection] = useState({ kind: 'ids', ids: new Set(['B']) });
        return h(LongTable, { label: 'Rows', rows, columns, rowId: r => r.id, hasMore: false, onLoadMore: () => {}, empty: 'None',
          selection, onSelectionChange: setSelection, activeRowId: 'C' });
      }
      createRoot(document.getElementById('root')).render(h(Harness));
    `,
  });
}, 60_000);

afterAll(async () => {
  await mounted?.close();
});

/** What a row shows: its fill, the bar at its start edge, and the weight of its text. */
const look = (id: string) => mounted.page.evaluate(rowId => {
  const row = document.querySelector<HTMLElement>(`[data-row-id="${rowId}"]`)!;
  const cell = row.querySelector<HTMLElement>('[role="rowheader"], [role="gridcell"]')!;
  const style = getComputedStyle(row);
  return { fill: style.backgroundColor, bar: style.boxShadow, weight: getComputedStyle(cell).fontWeight };
}, id);

const token = (name: string) => mounted.page.evaluate(n => {
  const probe = document.body.appendChild(document.createElement("div"));
  probe.style.background = `var(${n})`;
  const value = getComputedStyle(probe).backgroundColor;
  probe.remove();
  return value;
}, name);

test("in Console a checked row and the open row share one tint, and only the open row adds a start bar and semibold text", async () => {
  const [plain, checked, open, selected] = [await look("A"), await look("B"), await look("C"), await token("--surface-selected")];
  expect(checked.fill).toBe(selected);
  expect(open.fill).toBe(selected);
  expect(plain.fill).not.toBe(selected);

  expect(plain.bar).toBe("none");
  expect(checked.bar).toBe("none");
  expect(open.bar).not.toBe("none");

  expect(Number(plain.weight)).toBeLessThan(600);
  expect(Number(checked.weight)).toBeLessThan(600);
  expect(Number(open.weight)).toBe(600);
});

test("checking and unchecking a row changes its tint as it happens, and the open row keeps its look either way", async () => {
  const { page } = mounted;
  const [plainFill, selected, open] = [(await look("A")).fill, await token("--surface-selected"), await look("C")];
  // The input is visually hidden; a pointer press lands on its label.
  const box = page.locator('[data-row-id="A"]').getByRole("checkbox").locator("xpath=ancestor::label[1]");
  await box.click();
  await expect.poll(async () => (await look("A")).fill).toBe(selected);
  await box.click();
  await page.mouse.move(0, 0); // off the row, which otherwise shows its hover fill
  await expect.poll(async () => (await look("A")).fill).toBe(plainFill);

  await page.locator('[data-row-id="C"]').getByRole("checkbox").locator("xpath=ancestor::label[1]").click();
  await expect.poll(async () => page.locator('[data-row-id="C"]').getAttribute("data-selected")).toBe("true");
  expect(await look("C")).toEqual(open);
});
