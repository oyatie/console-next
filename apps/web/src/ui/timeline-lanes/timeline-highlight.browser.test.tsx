// SPDX-License-Identifier: LicenseRef-Proprietary
import { afterAll, beforeAll, expect, test } from "vitest";
import { mountBrowserModule, type MountedGallery } from "../../lib/gallery-browser-test";

let mounted: MountedGallery;

beforeAll(async () => {
  mounted = await mountBrowserModule({
    slug: "timeline-highlight-test",
    readySelector: "[data-lanes-ready]",
    viewport: { width: 1440, height: 900 },
    moduleCode: `
      import '/apps/web/src/app.css';
      import { createElement as h } from 'react';
      import { createRoot } from 'react-dom/client';
      import { loadCatalog } from '@console/i18n';
      import { TimelineLanes } from '/apps/web/src/ui/timeline-lanes/timeline-lanes.tsx';
      await loadCatalog('ko');
      const item = (key, highlight) => ({ key, date: '2026-11-0' + key, title: 'Event ' + key, highlight });
      createRoot(document.getElementById('root')).render(h('main', { 'data-lanes-ready': '' },
        h('section', { className: 'card' }, h(TimelineLanes, { items: [item('1', true), item('2', false)] }))));
    `,
  });
}, 60_000);
afterAll(async () => {
  await mounted?.close();
});

const fills = (experience: string, theme: string) => mounted.page.evaluate(([style, mode]) => {
  const root = document.documentElement;
  if (style) root.dataset.experience = style;
  else delete root.dataset.experience;
  root.dataset.theme = mode;
  return {
    card: getComputedStyle(document.querySelector(".card")!).backgroundColor,
    highlighted: getComputedStyle(document.querySelector("li[data-highlight]")!).backgroundColor,
  };
}, [experience, theme] as const);

test("on Console the record just recorded stands apart from its card in the selected fill, light and dark", async () => {
  expect(await fills("console", "light")).toEqual({ card: "rgb(255, 255, 255)", highlighted: "rgb(216, 236, 239)" });
  expect(await fills("console", "dark")).toEqual({ card: "rgb(24, 35, 46)", highlighted: "rgb(22, 56, 63)" });
});

test("today's look and warm-clear keep their info fill for the record just recorded", async () => {
  expect((await fills("", "light")).highlighted).toBe("rgb(239, 246, 255)");
  expect((await fills("warm-clear", "light")).highlighted).toBe("rgb(230, 238, 248)");
});
