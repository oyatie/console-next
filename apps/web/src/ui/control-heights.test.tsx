// SPDX-License-Identifier: LicenseRef-Proprietary
import { readFileSync, readdirSync } from "node:fs";
import { chromium, type Browser, type Page } from "@playwright/test";
import { afterAll, beforeAll, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ApprovalCard } from "./approval-card/approval-card";
import card from "./approval-card/approval-card.module.css";
import { mediaQueries } from "./breakpoints";
import { Button, IconButton } from "./button/button";
import { MenuButton } from "./menu/menu-button";
import menu from "./menu/menu.module.css";
import sheet from "./sheet-grid/window.module.css";

let browser: Browser;
let page: Page;
const tokens = new URL("../../../../packages/tokens/", import.meta.url);
const read = (file: string, base: URL | string = import.meta.url) => readFileSync(new URL(file, base), "utf8");
// A module's class names as the components write them. A browser drops a rule that holds `:global()`, so the global
// class inside it is written bare, as the build writes it.
const moduleCss = (file: string, classes: Record<string, string>) => read(file)
  .replace(/:global\(([^)]*)\)|\.([a-zA-Z][\w-]*)/g, (whole, global?: string, name?: string) => global ?? (name && classes[name] ? `.${classes[name]}` : whole));

beforeAll(async () => {
  browser = await chromium.launch();
  page = await browser.newPage();
  const experiences = readdirSync(new URL("experiences/", tokens)).filter(file => file.endsWith(".css")).map(file => read(`experiences/${file}`, tokens));
  // The build expands the named breakpoints; a browser reading the files as written would drop every such block.
  const css = [read("tokens.css", tokens), ...experiences, read("../app.css").replace(/@import[^;]+;/g, ""),
    moduleCss("./approval-card/approval-card.module.css", card), moduleCss("./menu/menu.module.css", menu), moduleCss("./sheet-grid/window.module.css", sheet)].join("\n")
    .replace(/\(--([\w-]+)\)/g, (query, name: string) => mediaQueries[name as keyof typeof mediaQueries] ?? query);
  const [save, close, filter, more, dots, paste, text] = ["Save", "×", "Filter", "More", "...", "Paste", "Example"];
  const nothing = () => undefined;
  // A container that gives controls a height of its own, beside an element as tall as a row.
  const own = '[data-probe="own"] { --control-h: 50px; } [data-probe="own"] > div { height: var(--row-h); }';
  await page.setContent(`<style>${css}${own}</style>${renderToStaticMarkup(<>
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
