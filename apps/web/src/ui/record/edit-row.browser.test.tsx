// SPDX-License-Identifier: LicenseRef-Proprietary
import { afterAll, beforeAll, expect, test } from "vitest";
import { mountBrowserModule, type MountedGallery } from "../../lib/gallery-browser-test";

let mounted: MountedGallery;

// A record section with a row being added in place, in Console, on a phone.
beforeAll(async () => {
  mounted = await mountBrowserModule({
    slug: "record-edit-row-test",
    readySelector: "[data-edit-row]",
    viewport: { width: 390, height: 844 },
    moduleCode: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { RecordSection } from '/apps/web/src/ui/record/record-section.tsx';
      import { EditRow } from '/apps/web/src/ui/record/inline.tsx';
      import '/apps/web/src/app.css';
      document.documentElement.dataset.experience = 'console';
      createRoot(document.getElementById('root')).render(
        React.createElement('div', { style: { overflowX: 'auto' }, 'data-scroller': '' },
          React.createElement(RecordSection, { id: 'education', title: 'education' },
            React.createElement(EditRow, { 'data-edit-row': '' }, 'row'))));
    `,
  });
}, 60_000);

afterAll(async () => {
  await mounted?.close();
});

// The row is tinted to its section's edges, which on a phone sit closer than on a desktop; past them the page scrolls sideways.
test("an added row reaches its section's edges without passing them on a phone", async () => {
  const { page } = mounted;
  const [row, body] = await Promise.all([
    page.locator("[data-edit-row]").boundingBox(),
    page.locator("[data-edit-row]").evaluate(el => el.parentElement!.getBoundingClientRect().toJSON() as DOMRect),
  ]);
  expect(row!.x).toBe(body.x);
  expect(row!.x + row!.width).toBe(body.x + body.width);
  expect(await page.locator("[data-scroller]").evaluate(el => el.scrollWidth - el.clientWidth)).toBe(0);
});
