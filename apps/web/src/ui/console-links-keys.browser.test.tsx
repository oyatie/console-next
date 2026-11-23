// SPDX-License-Identifier: LicenseRef-Proprietary
import { afterAll, beforeAll, expect, test } from "vitest";
import { mountBrowserModule, type MountedGallery } from "../lib/gallery-browser-test";

let mounted: MountedGallery;

beforeAll(async () => {
  mounted = await mountBrowserModule({
    slug: "console-links-keys",
    readySelector: '[role="group"][aria-label="Index"]',
    viewport: { width: 1440, height: 900 },
    moduleCode: `
      import { createElement as h } from 'react';
      import { createRoot } from 'react-dom/client';
      import { loadCatalog } from '@console/i18n';
      import { Crumbs } from '/apps/web/src/ui/page-head/crumbs.tsx';
      import { IndexBar } from '/apps/web/src/ui/index-bar/index-bar.tsx';
      import '/apps/web/src/app.css';
      await loadCatalog('ko');
      document.documentElement.dataset.experience = 'console';
      document.documentElement.dataset.theme = 'light';
      const access = h('div', { 'data-access-page': '' }, h('table', null, h('tbody', null, h('tr', null,
        h('td', null, h('a', { href: '#person', id: 'access-link' }, 'Person'))))));
      createRoot(document.getElementById('root')).render(h('main', null,
        h(Crumbs, { items: [h('a', { href: '#org', id: 'crumb-link' }, 'Org')], current: 'Sales' }),
        access,
        h(IndexBar, { label: 'Index', items: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], onSelect: () => {} })));
    `,
  });
}, 60_000);

afterAll(async () => {
  await mounted?.close();
});

const underline = (selector: string) => mounted.page.locator(selector).evaluate(el => getComputedStyle(el).textDecorationLine);

test("in Console a crumb and a link in an access table are underlined, as every link is drawn", async () => {
  expect(await underline("#crumb-link")).toBe("underline");
  expect(await underline("#access-link")).toBe("underline");
});

test("in Console an index key is a whole pointer target with a control's edge: 24 px on a desk, 44 px on a phone", async () => {
  const { page } = mounted;
  const key = page.getByRole("group", { name: "Index" }).getByRole("button", { name: "A", exact: true });
  const edge = () => key.evaluate(el => {
    const probe = document.body.appendChild(document.createElement("div"));
    probe.style.color = "var(--control-border)";
    const expected = getComputedStyle(probe).color;
    probe.remove();
    return { border: getComputedStyle(el).borderTopColor, expected };
  });
  const box = async () => (await key.boundingBox())!;

  const desk = await box();
  expect(desk.height).toBe(24);
  expect(desk.width).toBeGreaterThanOrEqual(24);
  const { border, expected } = await edge();
  expect(border).toBe(expected);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(async () => (await box()).height).toBe(44);
  expect((await box()).width).toBeGreaterThanOrEqual(44);
  await page.setViewportSize({ width: 1440, height: 900 });
});
