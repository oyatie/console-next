// SPDX-License-Identifier: LicenseRef-Proprietary
import { readFileSync, readdirSync } from "node:fs";
import { chromium, type Browser, type Page } from "@playwright/test";
import { afterAll, beforeAll, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
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
  const css = [readFileSync(new URL("tokens.css", tokens), "utf8"), ...experiences.map(file => readFileSync(new URL(`experiences/${file}`, tokens), "utf8")), app, record].join("\n");
  const [save, close, select, filter] = ["Save", "×", "Select", "Filter"];
  await page.setContent(`<style>${css}</style>${renderToStaticMarkup(<>
    <Button>{save}</Button><IconButton label="Close">{close}</IconButton>
    <Check checked={false} onChange={() => undefined}>{select}</Check>
    <ToggleButton look="chip" pressed={false}>{filter}</ToggleButton>
    <RowInput aria-label="Name" defaultValue="Example" />
  </>)}`);
}, 60_000);
afterAll(async () => { await browser?.close(); });

for (const file of experiences) for (const theme of ["light", "dark"]) test(`${file} ${theme} preserves rendered control and text floors`, async () => {
  const sizes = await page.evaluate(({ experience, theme }) => {
    const root = document.documentElement;
    root.dataset.theme = theme;
    delete root.dataset.experience;
    const controls = [...document.querySelectorAll<HTMLElement>("button, input")];
    const baseline = controls.map(el => el.getBoundingClientRect().height);
    root.dataset.experience = experience;
    return controls.map((el, i) => ({
      name: el.getAttribute("aria-label") || el.textContent || el.outerHTML,
      height: el.getBoundingClientRect().height,
      floor: Math.min(32, baseline[i]!),
      font: parseFloat(getComputedStyle(el).fontSize),
    }));
  }, { experience: file.slice(0, -4), theme });
  expect(sizes).toHaveLength(5);
  for (const control of sizes) {
    expect.soft(control.height, control.name).toBeGreaterThanOrEqual(control.floor);
    expect.soft(control.font, control.name).toBeGreaterThanOrEqual(14);
  }
});
