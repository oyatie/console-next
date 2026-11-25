// SPDX-License-Identifier: LicenseRef-Proprietary
import { readFileSync, readdirSync } from "node:fs";
import { afterAll, beforeAll, expect, test } from "vitest";
import { browserEngine, type Browser, type Page } from "../../lib/browser-test";
import { parseCss } from "../../../../../scripts/check-ds-refs.mjs";
import { mediaQueries } from "../breakpoints";

let browser: Browser;
let page: Page;
const experiences = readdirSync("packages/tokens/experiences").filter(file => file.endsWith(".css")).sort();
const sheets: Record<string, string> = {
  "packages/tokens/tokens.css": readFileSync("packages/tokens/tokens.css", "utf8"),
  ...Object.fromEntries(experiences.map(file => [`packages/tokens/experiences/${file}`, readFileSync(`packages/tokens/experiences/${file}`, "utf8")])),
  "apps/web/src/app.css": readFileSync("apps/web/src/app.css", "utf8").replace(/@import[^;]+;/g, ""),
};
const styles = ["baseline", ...experiences.map(file => file.slice(0, -4))];

/** The chevron stroke of a select off the frame and one on it, in every style and theme: "none" where there is none. */
const chevrons = (files: Record<string, string>) => page.evaluate(({ css, ids }) => {
  document.querySelector("style")!.textContent = css;
  const root = document.documentElement, found: Record<string, string[]> = {};
  for (const id of [null, ...ids]) for (const theme of ["light", "dark"]) {
    if (id) root.dataset.experience = id;
    else delete root.dataset.experience;
    root.dataset.theme = theme;
    found[`${id ?? "unset"} ${theme}`] = [...document.querySelectorAll("select")].map(select => {
      const image = getComputedStyle(select).backgroundImage;
      return image === "none" ? image : image.match(/stroke='%23([\da-f]{6})'/i)?.[1] ?? image;
    });
  }
  return found;
}, {
  // The build expands the named breakpoints; a browser reading the files as written would drop every such block.
  css: Object.values(files).join("\n").replace(/\(--([\w-]+)\)/g, (query, name: string) => mediaQueries[name as keyof typeof mediaQueries] ?? query),
  ids: styles,
});

const LIGHT = "55616d", DARK = "c3cdd8";
// Off the frame, then on it. Today's look keeps the platform's arrow; Console's frame is dark in the light theme too.
const DRAWN = {
  "unset light": ["none", "none"], "unset dark": ["none", "none"],
  "baseline light": ["none", "none"], "baseline dark": ["none", "none"],
  "console light": [LIGHT, DARK], "console dark": [DARK, DARK],
  "warm-clear light": [LIGHT, LIGHT], "warm-clear dark": [DARK, DARK],
};

beforeAll(async () => {
  browser = await browserEngine().launch();
  page = await browser.newPage();
  await page.setContent('<style></style><select class="field__input"><option>A</option></select><header data-surface="chrome"><select class="field__input"><option>A</option></select></header>');
}, 60_000);
afterAll(async () => { await browser?.close(); });

test("a select's chevron is drawn for the ground it sits on, in every style and theme", async () => {
  expect(await chevrons(sheets)).toEqual(DRAWN);
});

test("every chevron declaration decides at least one case", async () => {
  const cut: string[] = [];
  for (const file of Object.keys(sheets)) for (let n = 0; ; n++) {
    let seen = 0, label = "";
    const sheet = parseCss(sheets[file]!, file);
    sheet.walkDecls(decl => {
      // By a chevron token's name, or by the chevron's path, so an inline copy of the image counts too.
      if (!/chevron|m6 9 6 6 6-6/.test(`${decl.prop}:${decl.value}`) || seen++ !== n) return;
      label = `${file}: ${decl.prop}: ${decl.value.slice(0, 32)}`;
      decl.remove();
    });
    if (!label) break;
    cut.push(label);
    expect(await chevrons({ ...sheets, [file]: sheet.toString() }), `without ${label}`).not.toEqual(DRAWN);
  }
  expect(cut).toHaveLength(7);
});
