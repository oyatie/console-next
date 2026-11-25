// SPDX-License-Identifier: LicenseRef-Proprietary
import { afterAll, beforeAll, expect, test } from "vitest";
import { mountBrowserModule, type MountedGallery } from "../../lib/gallery-browser-test";

let mounted: MountedGallery;

beforeAll(async () => {
  mounted = await mountBrowserModule({
    slug: "masked-code-face-test",
    readySelector: "[data-faces-ready]",
    viewport: { width: 1440, height: 900 },
    moduleCode: `
      import '/apps/web/src/app.css';
      import { createElement as h } from 'react';
      import { createRoot } from 'react-dom/client';
      import { Masked } from '/apps/web/src/ui/record/masked.tsx';
      createRoot(document.getElementById('root')).render(h('main', { 'data-faces-ready': '' },
        h('p', { 'data-face': 'masked' }, h(Masked, null, '900101-1******')),
        h('p', null, h('span', { className: 'code', 'data-face': 'code' }, 'OC-2026-0418'))));
    `,
  });
}, 60_000);
afterAll(async () => {
  await mounted?.close();
});

const faces = (experience: string) => mounted.page.evaluate(style => {
  const root = document.documentElement;
  if (style) root.dataset.experience = style;
  else delete root.dataset.experience;
  const read = (el: Element) => ({ font: getComputedStyle(el).fontFamily, tracking: getComputedStyle(el).letterSpacing });
  return {
    body: read(document.body).font,
    masked: read(document.querySelector("[data-face='masked'] > span")!),
    code: read(document.querySelector("[data-face='code']")!).font,
  };
}, experience);

test("on Console codes and masked values read in the body face, untracked", async () => {
  const { body, masked, code } = await faces("console");
  expect(body).not.toContain("monospace");
  expect(masked).toEqual({ font: body, tracking: "normal" });
  expect(code).toBe(body);
});

test("today's look and warm-clear keep the code face and the masked tracking", async () => {
  for (const experience of ["", "warm-clear"]) {
    const { masked, code } = await faces(experience);
    expect(masked.font, experience).toContain("monospace");
    expect(masked.tracking, experience).toBe("0.5px");
    expect(code, experience).toContain("monospace");
  }
});
