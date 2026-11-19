// SPDX-License-Identifier: LicenseRef-Proprietary
import { readFileSync, readdirSync } from "node:fs";
import { chromium, type Browser, type Page } from "@playwright/test";
import { afterAll, beforeAll, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ApprovalCard } from "./approval-card/approval-card";
import card from "./approval-card/approval-card.module.css";
import { mediaQueries } from "./breakpoints";
import { Button, IconButton } from "./button/button";
import { TextInput } from "./field/field";
import { SelectInput } from "./field/select-input";
import { TextArea } from "./field/text-area";
import { MenuButton } from "./menu/menu-button";
import menu from "./menu/menu.module.css";
import editor from "./sheet-grid/input.module.css";
import grid from "./sheet-grid/sheet-grid.module.css";
import sheet from "./sheet-grid/window.module.css";

let browser: Browser;
let page: Page;
const tokens = new URL("../../../../packages/tokens/", import.meta.url);
const read = (file: string, base: URL | string = import.meta.url) => readFileSync(new URL(file, base), "utf8");
// A module's class names as the components write them. A browser drops a rule that holds `:global()`, so the global
// class inside it is written bare, as the build writes it.
const moduleCss = (file: string, classes: Record<string, string>) => read(file)
  .replace(/:global\(([^)]*)\)|\.([a-zA-Z][\w-]*)/g, (whole, global?: string, name?: string) => global ?? (name && classes[name] ? `.${classes[name]}` : whole));
// Two feature sheets are read as text and never imported, since nothing under ui may import a feature. Each gets class
// names of its own, as importing the module would give it, so no rule in them reaches another probe.
const scoped = (slice: string) => new Proxy({} as Record<string, string>, { get: (_, name) => `${slice}-${String(name)}` });
const chart = scoped("chart"), roster = scoped("roster");

beforeAll(async () => {
  browser = await chromium.launch();
  page = await browser.newPage();
  const experiences = readdirSync(new URL("experiences/", tokens)).filter(file => file.endsWith(".css")).map(file => read(`experiences/${file}`, tokens));
  // The build expands the named breakpoints; a browser reading the files as written would drop every such block.
  const css = [read("tokens.css", tokens), ...experiences, read("../app.css").replace(/@import[^;]+;/g, ""),
    moduleCss("./approval-card/approval-card.module.css", card), moduleCss("./menu/menu.module.css", menu), moduleCss("../features/structure/ui/chart.module.css", chart),
    moduleCss("../features/people/ui/roster.module.css", roster),
    // In the order the sheet grid imports them: its window sheet takes a row's least height away again.
    moduleCss("./sheet-grid/sheet-grid.module.css", grid), moduleCss("./sheet-grid/input.module.css", editor), moduleCss("./sheet-grid/window.module.css", sheet)].join("\n")
    .replace(/\(--([\w-]+)\)/g, (query, name: string) => mediaQueries[name as keyof typeof mediaQueries] ?? query);
  const [save, close, filter, more, dots, paste, text] = ["Save", "×", "Filter", "More", "...", "Paste", "Example"];
  const nothing = () => undefined;
  // A container that gives controls a height of its own, beside an element as tall as a row.
  const own = '[data-probe="own"] { --control-h: 50px; } [data-probe="own"] > div { height: var(--row-h); }';
  // One that gives fields a height of their own, beside an element as tall as a row and a button.
  const ownField = '[data-probe="own-field"] { --field-h: 50px; } [data-probe="own-field"] > div { height: var(--row-h); }';
  // The sheet grid's cell editor as the grid writes it: the shared text input in a cell of a row.
  const cell = (probe: string, density?: "compact") => <section data-probe={probe} data-density={density}>
    <div className={`${grid.grid} ${sheet.grid}`}><div className={`${grid.row} ${sheet.row}`}>
      <span className={`${grid.cell} ${editor.cell}`}><TextInput aria-label={text} className={editor.edit} /></span>
    </div></div>
  </section>;
  await page.setContent(`<style>${css}${own}${ownField}</style>${renderToStaticMarkup(<>
    <section data-probe="button"><Button>{save}</Button></section>
    <section data-probe="icon"><IconButton label="Close">{close}</IconButton></section>
    <section data-probe="toolbar"><div className="toolbar"><Button>{filter}</Button></div></section>
    <section data-probe="bare"><div className="toolbar" /></section>
    <section data-probe="decision">
      <ApprovalCard eyebrow={text} step={text} title={text} consequence={text} rejectConsequence={text} approveLabel="Approve" rejectLabel="Reject"
        reason={() => null} reasonComplete={false} onApprove={nothing} onReject={nothing}>{text}</ApprovalCard>
    </section>
    <section data-probe="menu"><MenuButton label={more} icon={<span aria-hidden>{dots}</span>} caret={false} items={[]} onAction={nothing} /></section>
    <section data-probe="compact" data-density="compact"><div className={sheet.grid}>
      <Button>{paste}</Button><div className="toolbar" /><div className={card.bar}><Button>{save}</Button></div>
    </div></section>
    <section data-probe="own"><Button>{save}</Button><div /></section>
    <section data-probe="field">
      <TextInput aria-label={text} /><SelectInput aria-label={text}><option>{text}</option></SelectInput>
      {/* One line of text, so only its least height can give it one. */}
      <TextArea aria-label={text} rows={1} /><div className="field__static" />
    </section>
    <section data-probe="field-toolbar"><div className="toolbar"><TextInput aria-label={text} /></div></section>
    {/* The chart's find box, put in a toolbar: the one place a toolbar's rule for a field could contest its module's. */}
    <section data-probe="chart-find"><div className="toolbar"><div className={chart.toolbarFind}><TextInput aria-label={text} /></div></div></section>
    {/* The roster's room for the find box its table puts there once loaded, with nothing in it yet. */}
    <section data-probe="find-slot"><span className={roster.findSlot} /></section>
    {cell("cell")}{cell("compact-cell", "compact")}
    <section data-probe="compact-field-toolbar" data-density="compact"><div className={sheet.grid}><div className="toolbar"><TextInput aria-label={text} /></div></div></section>
    <section data-probe="own-field"><TextInput aria-label={text} /><div /><Button>{save}</Button></section>
  </>)}`);
}, 60_000);
afterAll(async () => { await browser?.close(); });

const WIDTHS = { desk: 1280, phone: 390 } as const;
type Form = keyof typeof WIDTHS;

/** Rendered sizes, in px, in a visual style (none: today's look) at a width, in the light theme. */
async function sizes(experience: string | null, form: Form) {
  await page.setViewportSize({ width: WIDTHS[form], height: 800 });
  return page.evaluate(style => {
    const root = document.documentElement;
    root.dataset.theme = "light";
    if (style) root.dataset.experience = style;
    else delete root.dataset.experience;
    const box = (selector: string) => {
      const found = document.querySelectorAll<HTMLElement>(selector);
      if (found.length !== 1) throw new Error(`${selector} matches ${found.length} elements`);
      return found[0]!.getBoundingClientRect();
    };
    const pad = getComputedStyle(document.querySelector('[data-probe="toolbar"] .toolbar')!);
    return {
      button: box('[data-probe="button"] button').height,
      icon: [box('[data-probe="icon"] button').width, box('[data-probe="icon"] button').height],
      toolbar: box('[data-probe="toolbar"] .toolbar').height,
      toolbarPadding: [parseFloat(pad.paddingTop), parseFloat(pad.paddingBottom)],
      toolbarButton: box('[data-probe="toolbar"] button').height,
      // Nothing in it, so only its least height can give it one.
      bareToolbar: box('[data-probe="bare"] .toolbar').height,
      decision: box('[data-probe="decision"] .btn--primary').height,
      menuIcon: [box('[data-probe="menu"] button').width, box('[data-probe="menu"] button').height],
      compactGrid: {
        button: box('[data-probe="compact"] > div > button').height,
        toolbar: box('[data-probe="compact"] .toolbar').height,
        decision: box('[data-probe="compact"] div > div > button').height,
      },
    };
  }, experience);
}

// A compact grid has 32px rows today and in Warm clear: a button is the row less 4px, a toolbar that and 12px above and
// below, a decision button the row.
const COMPACT = { button: 28, toolbar: 52, decision: 32 };
// What each style draws today. A change to how these sizes are worked out leaves every number here as it is.
const TODAY = {
  baseline: { button: 36, icon: [36, 36], toolbar: 60, toolbarPadding: [12, 12], toolbarButton: 36, bareToolbar: 60, decision: 40, menuIcon: [36, 36], compactGrid: COMPACT },
  "warm-clear": { button: 52, icon: [52, 52], toolbar: 76, toolbarPadding: [12, 12], toolbarButton: 52, bareToolbar: 76, decision: 56, menuIcon: [52, 52], compactGrid: COMPACT },
};

for (const style of ["baseline", "warm-clear"] as const) test.each(["desk", "phone"] as const)(`${style} draws its controls and toolbars at today's sizes on a %s`, async form => {
  expect(await sizes(style === "baseline" ? null : style, form)).toEqual(TODAY[style]);
});

test("a control's height is a role of its own: a container that sets it moves the button and not the row", async () => {
  await sizes(null, "desk");
  expect(await page.evaluate(() => ({
    button: document.querySelector('[data-probe="own"] button')!.getBoundingClientRect().height,
    row: document.querySelector('[data-probe="own"] > div')!.getBoundingClientRect().height,
  }))).toEqual({ button: 50, row: 40 });
});

// As its boards draw them: a 24px control in a 40px toolbar on a desk, and touch sizes on a phone. The boards draw no
// compact grid: what sits in one is as tall as its row, 24px on a desk and 40px on a phone, which is under the 44px
// touch size, and a toolbar there adds its 4px above and below.
test("Control room draws controls and toolbars at its own sizes, apart from its row height", async () => {
  expect.soft(await sizes("control-room", "desk")).toEqual({ button: 24, icon: [24, 24], toolbar: 40, toolbarPadding: [4, 4], toolbarButton: 24, bareToolbar: 40, decision: 32, menuIcon: [24, 24], compactGrid: { button: 24, toolbar: 32, decision: 24 } });
  expect.soft(await sizes("control-room", "phone")).toEqual({ button: 44, icon: [44, 44], toolbar: 52, toolbarPadding: [4, 4], toolbarButton: 44, bareToolbar: 52, decision: 48, menuIcon: [44, 44], compactGrid: { button: 40, toolbar: 48, decision: 40 } });
});

/** Rendered heights, in px, of what a person types into or picks from, in a visual style at a width, in the light theme. */
async function fields(experience: string | null, form: Form) {
  await sizes(experience, form);
  return page.evaluate(() => {
    const height = (selector: string) => {
      const found = document.querySelectorAll<HTMLElement>(selector);
      if (found.length !== 1) throw new Error(`${selector} matches ${found.length} elements`);
      return found[0]!.getBoundingClientRect().height;
    };
    // A text input, then what holds it.
    const held = (probe: string, holder: string) => [height(`[data-probe="${probe}"] input`), height(`[data-probe="${probe}"] ${holder}`)];
    return {
      input: height('[data-probe="field"] input'),
      select: height('[data-probe="field"] select'),
      area: height('[data-probe="field"] textarea'),
      static: height('[data-probe="field"] .field__static'),
      toolbar: held("field-toolbar", ".toolbar"),
      chartFind: height('[data-probe="chart-find"] input'),
      findSlot: height('[data-probe="find-slot"] span'),
      cell: held("cell", "span"),
      compactCell: held("compact-cell", "span"),
      compactToolbar: held("compact-field-toolbar", ".toolbar"),
    };
  });
}

// A compact grid has 32px rows today and in Warm clear: its cell editor is as tall as the row, and so is a field in a
// toolbar there, which with 12px above and below makes that toolbar taller than its least height.
const COMPACT_FIELDS = { compactCell: [32, 32], compactToolbar: [32, 56] };
// What each style draws today: a field is as tall as a row, in a toolbar too, where it makes the toolbar taller than
// its least height. The chart's find box is as tall as a button, by its own module's rule, in a toolbar as well. The
// roster keeps a field's height free for its find box.
const FIELDS_TODAY = {
  baseline: { input: 40, select: 40, area: 80, static: 40, toolbar: [40, 64], chartFind: 36, findSlot: 40, cell: [40, 40], ...COMPACT_FIELDS },
  "warm-clear": { input: 56, select: 56, area: 112, static: 56, toolbar: [56, 80], chartFind: 52, findSlot: 56, cell: [56, 56], ...COMPACT_FIELDS },
};

for (const style of ["baseline", "warm-clear"] as const) test.each(["desk", "phone"] as const)(`${style} draws its fields at today's sizes on a %s`, async form => {
  expect(await fields(style === "baseline" ? null : style, form)).toEqual(FIELDS_TODAY[style]);
});

test("a field's height is a role of its own: a container that sets it moves the input, and not the row or the button", async () => {
  await sizes(null, "desk");
  expect(await page.evaluate(() => {
    const height = (selector: string) => document.querySelector(`[data-probe="own-field"] > ${selector}`)!.getBoundingClientRect().height;
    return { input: height("input"), row: height("div"), button: height("button") };
  })).toEqual({ input: 50, row: 40, button: 36 });
});

// As its boards draw them: a 28px field on a desk, and in a toolbar a 24px one, level with the controls beside it. On a
// phone a field is the 48px a row is, and 44px in a toolbar, so the toolbar holding it is the 52px its own height says.
// In a compact grid a field is as tall as the compact row, in a cell and in a toolbar: 24px on a desk, 40px on a phone.
test("Control room draws fields at its own sizes: level with the controls in a toolbar, as tall as the row in a compact grid", async () => {
  expect.soft(await fields("control-room", "desk")).toEqual({ input: 28, select: 28, area: 56, static: 28, toolbar: [24, 40], chartFind: 24, findSlot: 28, cell: [28, 28], compactCell: [24, 24], compactToolbar: [24, 32] });
  expect.soft(await fields("control-room", "phone")).toEqual({ input: 48, select: 48, area: 96, static: 48, toolbar: [44, 52], chartFind: 44, findSlot: 48, cell: [48, 48], compactCell: [40, 40], compactToolbar: [40, 48] });
});
