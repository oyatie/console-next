#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Proprietary
// WCAG contrast and the catalogue's Machado severity-1 CVD / OKLab separation proof, from tokens.css.
// Each experience file beside it (experiences/<id>.css) is checked again as an overlay on those tokens.
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { context, decodeIdent, experienceBlocks, literalColour, parseCss, rootDeclaration } from "./check-ds-refs.mjs";

/**
 * The experience token files beside a base token file: the regular files `experiences/<id>.css`. There are none when
 * the folder is absent, and none either in a file that has its name or in a folder named like an experience.
 */
export function experienceFiles(tokensFile) {
  const dir = path.join(path.dirname(tokensFile), "experiences");
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return [];
  const regular = (name) => statSync(path.join(dir, name), { throwIfNoEntry: false })?.isFile();
  return readdirSync(dir).filter((name) => name.endsWith(".css") && regular(name)).sort().map((name) => path.join(dir, name));
}

export function themeTokens(css) {
  const themes = { light: {}, dark: {} };
  const sheet = parseCss(css);
  // Qualified themes override bare :root independently of source order.
  for (const qualified of [false, true]) sheet.walkDecls((decl) => {
    if (!rootDeclaration(decl)) return;
    const { theme, conditions } = context(decl);
    if (conditions.length || Boolean(theme) !== qualified) return;
    const name = decodeIdent(decl.prop);
    if (name.startsWith("--")) for (const mode of theme ? [theme] : ["light", "dark"]) themes[mode][name] = decl.value.trim();
  });
  return themes;
}

/**
 * The tokens in force when an experience is set, from the base themes and the experience's own blocks. The browser
 * orders the four rules by specificity: the experience's dark block (:root and two attributes) outranks the rest and
 * its light block (:root and one attribute) outranks the base's light block. The light block only ties the base's
 * dark block, where stylesheet order would decide. experienceBlocks refuses a token left to that tie, so a file that
 * passes resolves the same in either order; a refused one is read here as if the experience file came later.
 */
export const experienceThemes = (base, own) => ({
  light: { ...base.light, ...own.light },
  dark: { ...base.dark, ...own.light, ...own.dark },
});

const linear = (v) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
function rgb(hex) {
  if (!/^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(hex)) throw new Error(`unsupported colour ${hex}`);
  const full = hex.length === 4 ? [...hex.slice(1)].map((v) => v + v).join("") : hex.slice(1);
  return [0, 2, 4].map((i) => linear(parseInt(full.slice(i, i + 2), 16) / 255));
}
const luminance = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
export function contrastRatio(a, b) {
  const [x, y] = [luminance(rgb(a)), luminance(rgb(b))].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
export const meetsContrast = (ratio, kind) => ratio >= (kind === "text" ? 4.5 : 3);

function resolve(tokens, name, seen = new Set()) {
  if (seen.has(name)) throw new Error(`cyclic token ${name}`);
  const value = tokens[name];
  if (!value) throw new Error(`undefined token ${name}`);
  const alias = value.match(/^var\(\s*(--[\w-]+)\s*\)$/);
  return alias ? resolve(tokens, alias[1], new Set([...seen, name])) : value;
}

// Machado et al. 2009, severity 1; same matrices and 0.04 floor as the catalogue's vl-proof.mjs.
const VIEWS = {
  normal: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
  protan: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deutan: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.01182, 0.04294, 0.968881]],
  tritan: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.3039]],
};
function oklab([r, g, b]) {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}

export const checkContrast = (css) => checkThemes(themeTokens(css));

/** The base token file, then every experience file beside it as an overlay on it. */
export function checkTokens(file) {
  const css = readFileSync(file, "utf8");
  const base = themeTokens(css);
  const result = checkThemes(base);
  // Declared names, not a comparison of the merged themes: a token may hold one value in both of the base's blocks.
  const baseDark = new Set();
  parseCss(css).walkDecls((decl) => {
    if (rootDeclaration(decl) && context(decl).theme === "dark") baseDark.add(decodeIdent(decl.prop));
  });
  // The experiences' dark rule takes the base's dark block as the list of its colours: one written for light only escapes it.
  for (const [name, value] of Object.entries(base.light)) {
    if (literalColour(value) && !baseDark.has(name))
      result.problems.push(`${file.split(path.sep).join("/")}: ${name} is a colour set for light only, so dark would show its light value; declare it under :root[data-theme="dark"] too`);
  }
  for (const overlay of experienceFiles(file)) {
    const id = path.basename(overlay, ".css");
    const own = experienceBlocks(readFileSync(overlay, "utf8"), id, baseDark, overlay);
    const contrast = checkThemes(experienceThemes(base, own), `experience ${id}, `);
    result.checked += contrast.checked;
    result.problems.push(...own.problems.map((problem) => `${overlay.split(path.sep).join("/")}: ${problem}`), ...contrast.problems);
  }
  return result;
}

function checkThemes(themes, label = "") {
  const problems = [];
  let checked = 0;
  for (const [mode, tokens] of Object.entries(themes)) {
    const theme = label + mode;
    const check = (fg, bg, kind) => {
      checked++;
      try {
        const ratio = contrastRatio(resolve(tokens, fg), resolve(tokens, bg));
        if (!meetsContrast(ratio, kind)) problems.push(`${theme}: ${fg}/${bg} ${ratio.toFixed(4)}:1 < ${kind === "text" ? 4.5 : 3}:1`);
      } catch (error) { problems.push(`${theme}: ${fg}/${bg}: ${error.message}`); }
    };
    for (const fg of ["--ink", "--steel", "--faint", "--primary"]) {
      for (const bg of ["--surface", "--canvas", "--muted"]) check(fg, bg, "text");
    }
    for (const role of Object.keys(tokens).filter((name) => name.endsWith("-tx")).map((name) => name.slice(2, -3))) {
      check(`--${role}-tx`, `--${role}-bg`, "text");
      check(`--${role}-tx`, "--surface", "text");
    }
    check("--primary", "--primary-soft", "text");
    check("--on-primary", "--primary", "text");
    check("--on-primary", "--primary-hover", "text");
    check("--on-danger", "--danger-solid", "text");
    check("--on-signal", "--signal", "text");
    check("--surface", "--ink", "text");
    // Decorative -bd, --border/--border-soft and chart gridlines carry no shape-only meaning.
    // Sequential steps 1–4 require value labels / a table view (visual-language §3.3).
    const marks = new Set(["--control-border", "--primary", "--chart-axis", "--chart-seq-5", "--chart-edge-entity", "--chart-edge-site", "--chart-edge-dept", "--grid-chg", "--grid-err", "--grid-rng",
      ...Object.keys(tokens).filter((name) => /-solid$|^--chart-cat-/.test(name))]);
    for (const fg of marks) for (const bg of ["--surface", "--canvas"]) check(fg, bg, "non-text");
    for (const fg of ["--control-border", "--neutral-solid", "--primary", "--danger-solid"]) check(fg, "--muted", "non-text");
    for (const fg of ["--primary", "--danger-solid"]) for (const bg of ["--primary-soft", "--danger-bg"]) check(fg, bg, "non-text");
    try {
      const cats = Array.from({ length: 6 }, (_, i) => rgb(resolve(tokens, `--chart-cat-${i + 1}`)));
      for (const [view, matrix] of Object.entries(VIEWS)) {
        const colours = cats.map((colour) => oklab(matrix.map((row) => Math.min(1, Math.max(0, row.reduce((sum, v, i) => sum + v * colour[i], 0))))));
        for (let i = 0; i < colours.length; i++) for (let j = i + 1; j < colours.length; j++) {
          checked++;
          const distance = Math.hypot(...colours[i].map((v, k) => v - colours[j][k]));
          if (distance < 0.04) problems.push(`${theme}: CVD ${view} --chart-cat-${i + 1}/--chart-cat-${j + 1} ΔOKLab ${distance.toFixed(4)} < 0.04`);
        }
      }
    } catch (error) { problems.push(`${theme}: CVD: ${error.message}`); }
  }
  return { checked, problems };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const at = process.argv.indexOf("--tokens");
  try {
    const result = checkTokens(at >= 0 ? process.argv[at + 1] : "packages/tokens/tokens.css");
    console.log(`contrast: ${result.checked} checks, ${result.problems.length} problem(s)`);
    if (result.problems.length) console.error(result.problems.join("\n"));
    process.exitCode = result.problems.length ? 1 : 0;
  } catch (error) { console.error(`contrast: ${error.message}`); process.exitCode = 1; }
}
