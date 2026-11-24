// SPDX-License-Identifier: LicenseRef-Proprietary
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { renderToStaticMarkup as html } from "react-dom/server";
import { mountBrowserModule, type MountedGallery } from "../lib/gallery-browser-test";
import { Chip } from "./chip";

test.each(["ok", "warn", "danger", "info", "neutral", "accent"] as const)("%s chips retain text and their tone class", tone => {
  const label = "State";
  expect(html(<Chip tone={tone}>{label}</Chip>)).toBe(`<span class="chip chip--${tone}">${label}</span>`);
});

test("chips forward an optional layout class", () => {
  const label = "Main";
  expect(html(<Chip className="slot">{label}</Chip>)).toBe(`<span class="chip chip--neutral slot">${label}</span>`);
});

describe("chip tones in each style", () => {
  const tones = ["warn", "danger", "info", "accent", "neutral", "outline"];
  let mounted: MountedGallery;

  beforeAll(async () => {
    mounted = await mountBrowserModule({
      slug: "chip-tones-test",
      readySelector: "[data-chips]",
      viewport: { width: 1440, height: 900 },
      moduleCode: `
        import '/apps/web/src/app.css';
        import { createElement as h } from 'react';
        import { createRoot } from 'react-dom/client';
        import { Chip } from '/apps/web/src/ui/chip.tsx';
        import { DeadlineChip } from '/apps/web/src/ui/deadline-chip/deadline-chip.tsx';
        import record from '/apps/web/src/ui/record/record.module.css';
        import sheet from '/apps/web/src/ui/sheet-grid/sheet-grid.module.css';
        import grid from '/apps/web/src/features/people/ui/grid-columns.module.css';
        import tree from '/apps/web/src/features/org/ui/mini-tree.module.css';
        createRoot(document.getElementById('root')).render(h('main', { 'data-chips': '' },
          ${JSON.stringify(tones)}.map(tone => h(Chip, { key: tone, tone }, tone)),
          h('span', { 'data-tag': 'due' }, h(DeadlineChip, { severity: 'due', days: 3 })),
          h('span', { 'data-tag': 'record', 'data-k': 'fix', className: record.tag }, 'fix'),
          h('span', { 'data-tag': 'sheet', className: sheet.tag }, 'sheet'),
          h('span', { 'data-tag': 'grid', className: grid.tag }, 'grid'),
          h('span', { 'data-tag': 'tree', 'data-tone': 'chg', className: tree.tag }, 'tree'),
          h('div', { 'data-surface': 'chrome' },
            h('span', { 'data-tag': 'frame' }, h(Chip, { tone: 'warn' }, 'frame')),
            h('span', { 'data-tag': 'callout', style: { border: '1px solid var(--warn-bd)' } }, 'callout'))));
      `,
    });
  }, 60_000);
  afterAll(async () => {
    await mounted?.close();
  });

  const look = (experience: string, theme = "light") => mounted.page.evaluate(([style, mode]) => {
    const root = document.documentElement;
    if (style) root.dataset.experience = style;
    else delete root.dataset.experience;
    root.dataset.theme = mode;
    const read = (el: Element) => {
      const s = getComputedStyle(el);
      return { fill: s.backgroundColor, border: s.borderTopColor, text: s.color, weight: s.fontWeight };
    };
    return Object.fromEntries([
      ...[...document.querySelectorAll("[data-chips] > .chip")].map(chip => [chip.textContent, read(chip)]),
      ...[...document.querySelectorAll("[data-tag]")].map(el => [el.getAttribute("data-tag"), read(el.querySelector(".chip") ?? el)]),
    ]);
  }, [experience, theme] as const);
  // Every warn mark (the warn chip, the due-soon chip and the warn tags) shares one edge.
  const marks = ["warn", "due", "record", "sheet", "grid", "tree"];
  const edges = (chips: Awaited<ReturnType<typeof look>>) => marks.map(mark => chips[mark]!.border);

  test("Console tags take the warn mark, the neutral outline for info and a bold accent tag", async () => {
    const chips = await look("console");
    expect(edges(chips)).toEqual(marks.map(() => "rgb(196, 122, 0)"));
    expect(chips.due).toMatchObject({ fill: "rgb(253, 240, 213)", text: "rgb(138, 79, 0)" });
    // Inside the frame a warn tag takes the frame's warn edge, as a warn callout there does.
    expect([chips.frame!.border, chips.callout!.border]).toEqual(["rgb(146, 97, 10)", "rgb(146, 97, 10)"]);
    expect(chips.info).toEqual({ fill: "rgb(255, 255, 255)", border: "rgb(54, 66, 78)", text: "rgb(20, 29, 38)", weight: "700" });
    expect(chips.accent).toEqual({ fill: "rgb(223, 240, 242)", border: "rgba(0, 0, 0, 0)", text: "rgb(8, 86, 96)", weight: "700" });
    for (const tone of ["warn", "danger"]) expect(chips[tone]!.weight, tone).toBe("700");
    // Edge and plain tags keep their lighter weights.
    expect(chips.outline!.weight).toBe("600");
    expect(chips.neutral!.weight).not.toBe("700");
  });

  test("dark Console keeps the warn mark, the neutral info tag and the due-soon chip in the warn roles", async () => {
    const chips = await look("console", "dark");
    expect(edges(chips)).toEqual(marks.map(() => "rgb(196, 122, 0)"));
    expect(chips.info).toEqual({ fill: "rgb(24, 35, 46)", border: "rgb(195, 205, 216)", text: "rgb(238, 242, 246)", weight: "700" });
    expect(chips.due).toMatchObject({ fill: "rgb(58, 45, 19)", text: "rgb(245, 189, 79)" });
  });

  test("warm-clear keeps its own tag weight", async () => {
    const chips = await look("warm-clear");
    for (const tone of ["warn", "danger", "info"]) expect(chips[tone]!.weight, tone).toBe("550");
  });

  test("today's look keeps its warn border and info hue", async () => {
    const chips = await look("");
    // The due-soon chip keeps today's own due roles here.
    expect(edges(chips)).toEqual(marks.map(mark => (mark === "due" ? "rgb(246, 181, 33)" : "rgb(252, 211, 77)")));
    expect(chips.info).toEqual({ fill: "rgb(239, 246, 255)", border: "rgb(147, 197, 253)", text: "rgb(30, 64, 175)", weight: "600" });
    expect(chips.warn!.weight).toBe("600");
  });
});
