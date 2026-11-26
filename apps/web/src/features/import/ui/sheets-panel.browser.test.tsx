// SPDX-License-Identifier: LicenseRef-Proprietary
import { afterAll, beforeAll, expect, test } from "vitest";
import { mountBrowserModule, type MountedGallery } from "../../../lib/gallery-browser-test";

let mounted: MountedGallery;

// One workbook sheet waiting for its columns, in Console, on a phone.
beforeAll(async () => {
  mounted = await mountBrowserModule({
    slug: "import-sheets-panel-test",
    readySelector: "#import-sheets",
    viewport: { width: 390, height: 844 },
    moduleCode: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { loadCatalog } from '@console/i18n';
      import { SheetsPanel } from '/apps/web/src/features/import/ui/sheets-panel.tsx';
      import '/apps/web/src/app.css';
      await loadCatalog('ko');
      document.documentElement.dataset.experience = 'console';
      const sheet = { name: 'Synthetic sheet', status: 'needs_mapping', needs_confirmation: false, rows: 1, header_candidates: [] };
      const preview = { sheets: [sheet], available_targets: ['name'] };
      createRoot(document.getElementById('root')).render(
        React.createElement('main', { style: { overflowX: 'auto' } },
          React.createElement(SheetsPanel, { preview, mapping: {}, busy: false, onRemap: () => {} })));
    `,
  });
}, 60_000);

afterAll(async () => {
  await mounted?.close();
});

// The sheet's head carries its name, status, row count and the mapping action; on a phone they wrap rather than run past it.
test("a sheet's head wraps its action on a phone instead of scrolling the page sideways", async () => {
  const { page } = mounted;
  expect(await page.locator("main").evaluate(el => el.scrollWidth - el.clientWidth)).toBe(0);
  const head = await page.getByRole("heading", { name: /Synthetic sheet/, level: 3 }).evaluate(el => el.parentElement!.getBoundingClientRect().right);
  const action = await page.getByRole("button", { name: /Synthetic sheet/ }).first().boundingBox();
  expect(action!.x + action!.width).toBeLessThanOrEqual(head);
});
