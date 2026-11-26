// SPDX-License-Identifier: LicenseRef-Proprietary
import { afterAll, beforeAll, expect, test } from "vitest";
import { mountBrowserModule, type MountedGallery } from "../../lib/gallery-browser-test";

let mounted: MountedGallery;

// A page whose list is still loading under a scrolling tab strip (lanes with counts), in Console's fixed-height frame.
beforeAll(async () => {
  mounted = await mountBrowserModule({
    slug: "list-record-frame-test",
    readySelector: "[data-pattern='list-record']",
    viewport: { width: 1440, height: 900 },
    moduleCode: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { loadCatalog } from '@console/i18n';
      import { ListRecord } from '/apps/web/src/ui/patterns/list-record.tsx';
      import { TabNav } from '/apps/web/src/ui/tabs/tabs.tsx';
      import '/apps/web/src/app.css';
      await loadCatalog('ko');
      document.documentElement.dataset.experience = 'console';
      const pending = { isPending: true, error: null, data: undefined, refetch() {} };
      const tabs = React.createElement(TabNav, { label: 'lanes', overflow: 'scroll' },
        ['all', 'mine'].map(id => React.createElement('a', { key: id, href: '#' + id, 'aria-current': id === 'all' ? 'page' : undefined }, id)));
      createRoot(document.getElementById('root')).render(React.createElement(ListRecord, { q: pending, head: { title: 'list' }, tabs, list: null }));
    `,
  });
}, 60_000);

afterAll(async () => {
  await mounted?.close();
});

// The tab strip scrolls sideways, so the column would otherwise squeeze it to its border while the loading list fills the
// frame, then let it grow back when the rows arrive, moving every control below it.
test("a scrolling tab strip keeps its height while the list loads in the fixed frame", async () => {
  const nav = mounted.page.getByRole("navigation", { name: "lanes", exact: true });
  expect(await nav.evaluate(el => el.scrollHeight - el.clientHeight)).toBe(0);
  expect((await nav.getByRole("link", { name: "all", exact: true }).boundingBox())!.height).toBeGreaterThan(0);
});
