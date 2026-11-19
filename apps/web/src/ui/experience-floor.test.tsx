// SPDX-License-Identifier: LicenseRef-Proprietary
import { readFileSync, readdirSync } from "node:fs";
import { chromium, type Browser, type Page } from "@playwright/test";
import { afterAll, beforeAll, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { mediaQueries } from "./breakpoints";
import { floorOf } from "./experience-floors";
import { Button, Check, IconButton, ToggleButton } from "./button/button";
import { RowInput } from "./record/inline";
import classes from "./record/record.module.css";

let browser: Browser;
let page: Page;
const tokens = new URL("../../../../packages/tokens/", import.meta.url);
const experiences = readdirSync(new URL("experiences/", tokens)).filter(file => file.endsWith(".css"));

beforeAll(async () => {
  browser = await chromium.launch();
  page = await browser.newPage();
  const app = readFileSync(new URL("../app.css", import.meta.url), "utf8").replace(/@import[^;]+;/g, "");
  const record = readFileSync(new URL("./record/record.module.css", import.meta.url), "utf8")
    .replace(/\.([a-zA-Z][\w-]*)/g, (selector, name: string) => classes[name] ? `.${classes[name]}` : selector);
  // The build expands the named breakpoints; a browser reading the files as written would drop every such block.
  const css = [readFileSync(new URL("tokens.css", tokens), "utf8"), ...experiences.map(file => readFileSync(new URL(`experiences/${file}`, tokens), "utf8")), app, record].join("\n")
    .replace(/\(--([\w-]+)\)/g, (query, name: string) => mediaQueries[name as keyof typeof mediaQueries] ?? query);
  const [save, close, select, filter] = ["Save", "×", "Select", "Filter"];
  await page.setContent(`<style>${css}</style>${renderToStaticMarkup(<>
    <Button>{save}</Button><IconButton label="Close">{close}</IconButton>
    <Check checked={false} onChange={() => undefined}>{select}</Check>
    <ToggleButton look="chip" pressed={false}>{filter}</ToggleButton>
    <RowInput aria-label="Name" defaultValue="Example" />
  </>)}`);
}, 60_000);
afterAll(async () => { await browser?.close(); });

const WIDTHS = { desk: 1280, phone: 390 } as const;

const measure = (experience: string, theme: string) => page.evaluate(({ experience, theme }) => {
  const root = document.documentElement;
  root.dataset.theme = theme;
  delete root.dataset.experience;
  const controls = [...document.querySelectorAll<HTMLElement>("button, input")];
  const baseline = controls.map(el => el.getBoundingClientRect().height);
  root.dataset.experience = experience;
  return controls.map((el, i) => ({
    name: el.getAttribute("aria-label") || el.textContent || el.outerHTML,
    height: el.getBoundingClientRect().height,
    baseline: baseline[i]!,
    font: parseFloat(getComputedStyle(el).fontSize),
  }));
}, { experience, theme });

for (const file of experiences) for (const theme of ["light", "dark"]) for (const form of ["desk", "phone"] as const) test(`${file} ${theme} preserves rendered control and text floors on a ${form}`, async () => {
  const experience = file.slice(0, -4);
  const floor = floorOf(experience, form);
  await page.setViewportSize({ width: WIDTHS[form], height: 800 });
  const sizes = await measure(experience, theme);
  expect(sizes).toHaveLength(5);
  for (const control of sizes) {
    // A control that is already smaller than the floor at baseline (a row's own input, a filter chip) keeps baseline's size as its floor.
    expect.soft(control.height, control.name).toBeGreaterThanOrEqual(Math.min(floor.control, control.baseline));
    expect.soft(control.font, control.name).toBeGreaterThanOrEqual(floor.text);
  }
});

// A button's text is the page's text size (13 on a desk, 15 on a phone) until controls have a text role of their own;
// the boards draw 12 on a desk.
test.each(["light", "dark"])("Console draws its buttons at the height its boards do: 24px on a desk, 44px on a phone (%s)", async theme => {
  const button = async (form: keyof typeof WIDTHS) => {
    await page.setViewportSize({ width: WIDTHS[form], height: 800 });
    const [save, close] = await measure("console", theme);
    return { height: save!.height, font: save!.font, icon: close!.height };
  };
  expect(await button("desk")).toEqual({ height: 24, font: 13, icon: 24 });
  expect(await button("phone")).toEqual({ height: 44, font: 15, icon: 44 });
});
