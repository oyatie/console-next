// SPDX-License-Identifier: LicenseRef-Proprietary
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, test } from "vitest";

const script = fileURLToPath(new URL("./check-contrast.mjs", import.meta.url));
const tokens = fileURLToPath(new URL("../packages/tokens/tokens.css", import.meta.url));
const roots: string[] = [];
afterAll(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));
const api = async () => import(/* @vite-ignore */ script);
/** The gate over a base token file and, beside it, `experiences/<id>.css` for each given experience. */
const run = (css: string, experiences: Record<string, string> = {}) => {
  const root = mkdtempSync(path.join(tmpdir(), "check-contrast-"));
  roots.push(root);
  const file = path.join(root, "tokens.css");
  writeFileSync(file, css);
  for (const [id, source] of Object.entries(experiences)) {
    mkdirSync(path.join(root, "experiences"), { recursive: true });
    writeFileSync(path.join(root, "experiences", `${id}.css`), source);
  }
  return spawnSync("node", [script, "--tokens", file], { encoding: "utf8" });
};
const blocks = (id: string, light: string, dark = "") => `:root[data-experience="${id}"] { ${light} }\n:root[data-experience="${id}"][data-theme="dark"] { ${dark} }`;

test("all declared text and meaningful non-text pairs pass in light and dark", async () => {
  const { checkContrast } = await api();
  const result = checkContrast(readFileSync(tokens, "utf8"));
  expect(result.problems).toEqual([]);
  expect(result.checked).toBeGreaterThan(100);
  expect(spawnSync("node", [script], { encoding: "utf8" }).status).toBe(0);
});

test("non-text refuses 2.9:1 and accepts the unrounded 3.0:1 threshold", async () => {
  const { contrastRatio, meetsContrast } = await api();
  expect(meetsContrast(2.9, "non-text")).toBe(false);
  expect(meetsContrast(3, "non-text")).toBe(true);
  expect(meetsContrast(4.49, "text")).toBe(false);
  expect(meetsContrast(4.5, "text")).toBe(true);
  expect(contrastRatio("#000", "#fff")).toBe(21);
  const css = readFileSync(tokens, "utf8");
  expect(run(css + '\n:root { --control-border: #999999; }').status).toBe(1);
  expect(run(css + '\n:root { --control-border: #888888; }').status).toBe(0);
});

test("text, focus, meter track and refused outline each have a failing negative control in both themes", () => {
  const css = readFileSync(tokens, "utf8");
  for (const selector of [":root", ':root[data-theme="dark"]']) {
    for (const role of ["ink", "primary", "neutral-solid", "danger-solid"]) {
      const result = run(css + `\n${selector} { --${role}: var(--surface); }`);
      expect(result.status, `${selector} ${role}`).toBe(1);
      expect(result.stderr).toContain(`--${role}`);
    }
  }
});

test("unresolved aliases, alias cycles and unsupported colour values fail closed", () => {
  const css = readFileSync(tokens, "utf8");
  for (const value of ["var(--missing)", "var(--ink)", "not-a-colour"]) {
    const result = run(css + `\n:root { --ink: ${value}; }`);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--ink");
  }
});

test("categorical CVD separation refuses duplicate categories", () => {
  const css = readFileSync(tokens, "utf8");
  const result = run(css + '\n:root { --chart-cat-2: var(--chart-cat-1); }');
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("CVD");
});

test("the pair matrix retains muted surfaces, refused/selected outlines and every semantic text pair", async () => {
  const { checkContrast, themeTokens } = await api();
  const css = readFileSync(tokens, "utf8");
  const themes = themeTokens(css);
  for (const [theme, selector] of [["light", ":root"], ["dark", ':root[data-theme="dark"]']]) {
    // Equal colours force every configured pair to report, making a deleted check observable.
    const planted = `${css}\n${selector} { ${Object.keys(themes[theme]).map((name) => `${name}: #000;`).join(" ")} }`;
    const { problems } = checkContrast(planted);
    const expected: [string, string][] = [];
    for (const fg of ["--ink", "--steel", "--faint", "--primary"]) for (const bg of ["--surface", "--canvas", "--muted"]) expected.push([fg, bg]);
    for (const fg of ["--primary", "--danger-solid"]) for (const bg of ["--primary-soft", "--danger-bg"]) expected.push([fg, bg]);
    for (const name of Object.keys(themes[theme]).filter((name) => name.endsWith("-tx"))) {
      expected.push([name, name.replace(/-tx$/, "-bg")], [name, "--surface"]);
    }
    for (const [fg, bg] of expected) expect(problems.some((problem: string) => problem.startsWith(`${theme}: ${fg}/${bg} 1.0000:1`)), `${theme} ${fg}/${bg}`).toBe(true);
  }
});

test("an experience's light block applies in both themes and its dark block over that, by specificity", async () => {
  const { experienceThemes, themeTokens } = await api();
  const { experienceBlocks } = await import(/* @vite-ignore */ fileURLToPath(new URL("./check-ds-refs.mjs", import.meta.url)));
  const base = themeTokens(':root { --a: #000; --b: #000; --c: #000; } :root[data-theme="dark"] { --a: #fff; --b: #fff; --c: #fff; }');
  // The dark block is written first: its extra attribute outranks the light block wherever it sits.
  const own = experienceBlocks(':root[data-experience="calm"][data-theme="dark"] { --c: #333; } :root[data-experience="calm"] { --b: #222; --c: #222; }', "calm");
  expect(experienceThemes(base, own)).toEqual({
    light: { "--a": "#000", "--b": "#222", "--c": "#222" },
    // --b: the experience's light block only ties the base's dark block. It is read as the later rule, and refused.
    dark: { "--a": "#fff", "--b": "#222", "--c": "#333" },
  });
  expect(own.problems).toEqual([expect.stringContaining("--b is a colour set for light only")]);
});

test("the pair list runs per experience and per theme, and a failure names the experience", () => {
  const css = readFileSync(tokens, "utf8");
  const checks = (r: { stdout: string }) => Number(r.stdout.match(/contrast: (\d+) checks/)![1]);
  const base = run(css);
  const clean = run(css, { calm: blocks("calm", "--chart-grid: var(--border);"), warm: blocks("warm", "") });
  expect(clean.stderr).toBe("");
  expect(clean.status).toBe(0);
  expect(checks(clean)).toBe(3 * checks(base));

  const dark = run(css, { calm: blocks("calm", "", "--ink: var(--surface);"), warm: blocks("warm", "") });
  expect(dark.status).toBe(1);
  expect(dark.stderr).toContain("experience calm, dark: --ink/--surface 1.0000:1 < 4.5:1");
  expect(dark.stderr).not.toMatch(/experience calm, light:|warm|^(?:light|dark):/m);

  // A light-block value with no dark counterpart is what dark resolves too, not the base's dark value.
  const both = run(css, { calm: blocks("calm", "--ink: var(--canvas);") });
  expect(both.stderr).toContain("experience calm, light: --ink/--surface");
  expect(both.stderr).toContain("experience calm, dark: --ink/--surface");
});

test("with no experience file the gate reports the base file alone", () => {
  const css = readFileSync(tokens, "utf8");
  const bare = run(css);
  const root = roots.at(-1)!;
  mkdirSync(path.join(root, "experiences"));
  writeFileSync(path.join(root, "experiences", "notes.txt"), ":root { --ink: var(--surface); }");
  const empty = spawnSync("node", [script, "--tokens", path.join(root, "tokens.css")], { encoding: "utf8" });
  expect([empty.status, empty.stdout, empty.stderr]).toEqual([bare.status, bare.stdout, bare.stderr]);
  expect(bare.stdout).toMatch(/^contrast: \d+ checks, 0 problem\(s\)\n$/);
});

test.each([
  [":root { --row-h: 36px; }", ":root"],
  [':root[data-theme="dark"] { --row-h: 36px; }', ':root[data-theme="dark"]'],
  [':root[data-experience="warm"] { --row-h: 36px; }', ':root[data-experience="warm"]'],
  [':root[data-experience="calm"], .card { --row-h: 36px; }', ':root[data-experience="calm"], .card'],
  [':root[data-experience="calm"] .card { --row-h: 36px; }', ':root[data-experience="calm"] .card'],
  // A space makes the theme attribute a descendant's, not the root's.
  [':root[data-experience="calm"] [data-theme="dark"] { --row-h: 36px; }', ':root[data-experience="calm"] [data-theme="dark"]'],
  [':root[data-experience="calm"] { .card { --row-h: 36px; } }', ".card"],
  ["@font-face { font-family: Calm; }", "@font-face"],
  ['@media (min-width: 640px) { :root[data-experience="calm"] { --row-h: 36px; } }', "@media (min-width: 640px)"],
  // A statement with no declarations of its own: what it brings in is read by no gate.
  ['@import "../palette.css";\n:root[data-experience="calm"] { --row-h: 36px; }', '@import "../palette.css"'],
  ['@layer calm, base;\n:root[data-experience="calm"] { --row-h: 36px; }', "@layer calm, base"],
])("an experience file holds only its own light and dark blocks: %s", (css, where) => {
  const r = run(readFileSync(tokens, "utf8"), { calm: css });
  expect(r.status, r.stderr).toBe(1);
  expect(r.stderr).toContain(`experiences/calm.css: ${where} `);
  expect(r.stderr).toContain(':root[data-experience="calm"] or :root[data-experience="calm"][data-theme="dark"]');
});

test("an experience block declares tokens only, and none of them !important", () => {
  const css = readFileSync(tokens, "utf8");
  // The dark value is the one the dark rule asks for, yet !important in the light block would beat it in dark.
  for (const [light, dark] of [["--ink: #141a21 !important;", "--ink: #e8edf4;"], ["--ink: #141a21;", "--ink: #e8edf4 ! IMPORTANT;"]]) {
    const r = run(css, { calm: blocks("calm", light, dark) });
    expect(r.status, r.stderr).toBe(1);
    expect(r.stderr).toContain("experiences/calm.css: --ink is marked !important, which the order of the light and dark blocks does not account for; drop !important\n");
    // The marked value still counts as set: the one fix asked for is to drop the mark.
    expect(r.stderr).not.toContain("light only");
  }
  // A property on the root ties the base's dark rule as a token does, and no dark rule covers it.
  const property = run(css, { calm: blocks("calm", "--border: #d0d7e0; color-scheme: light;", "--border: #2b3542;") });
  expect(property.status, property.stderr).toBe(1);
  expect(property.stderr).toContain("experiences/calm.css: color-scheme is not a token; an experience file sets custom properties only, so remove it\n");
});

test("every colour an experience sets for light is also set for dark", () => {
  const css = readFileSync(tokens, "utf8");
  for (const [light, token] of [
    ["--border: #d0d7e0;", "--border"],
    ["--shadow: 0 1px 2px rgba(20, 26, 33, 0.08);", "--shadow"],
    ["--border-soft: gainsboro;", "--border-soft"],
    ["--scrim: oklch(20% 0.02 250 / 0.3);", "--scrim"],
    // A name the base does not have is held to the same rule.
    ["--calm-band: #102030;", "--calm-band"],
    // No colour is written, but the base sets these for dark: its rule ties the light block, so stylesheet order would decide.
    ["--border: var(--border-soft);", "--border"],
    ["--shadow: none;", "--shadow"],
    ["--scrim: transparent;", "--scrim"],
    // The base holds one value for this in both of its blocks; it is the declaration in the dark block that ties.
    ["--on-signal: var(--ink);", "--on-signal"],
  ]) {
    const r = run(css, { calm: blocks("calm", light) });
    expect(r.status, light).toBe(1);
    expect(r.stderr).toContain(`experiences/calm.css: ${token} is a colour set for light only, so dark would show its light value; set it in :root[data-experience="calm"][data-theme="dark"] too`);
  }
  expect(run(css, { calm: blocks("calm", "--border: #d0d7e0;", "--border: #2b3542;") }).status).toBe(0);
  expect(run(css, { calm: blocks("calm", "--border: var(--border-soft);", "--border: var(--border-soft);") }).status).toBe(0);
  // Sizes, fonts and tokens the base leaves to its light block: the experience's light block outranks that block outright.
  const exempt = run(css, { calm: blocks("calm", '--row-h: 36px; --radius: 0; --font-mono: "SF Mono", Menlo, monospace; --chart-grid: var(--border); --selected-bar: inset 4px 0 0 var(--primary); --calm-clear: transparent;') });
  expect(exempt.stderr).toBe("");
  expect(exempt.status).toBe(0);
});

test("the colour test picks out of the base's light block exactly the tokens its dark block sets", async () => {
  const { literalColour, parseCss } = await import(/* @vite-ignore */ fileURLToPath(new URL("./check-ds-refs.mjs", import.meta.url)));
  const light: string[] = [], dark: string[] = [];
  parseCss(readFileSync(tokens, "utf8")).walkDecls(/^--/, (decl: { prop: string; value: string; parent: { selector: string } }) => {
    if (decl.parent.selector !== ":root") dark.push(decl.prop);
    else if (literalColour(decl.value)) light.push(decl.prop);
  });
  expect(dark.length).toBeGreaterThan(50);
  expect(light.sort()).toEqual(dark.sort());
});
