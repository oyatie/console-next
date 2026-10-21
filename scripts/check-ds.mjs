#!/usr/bin/env node
// Design-system gate (design-language §5, §12 "bespoke control styling", "a second component for the same pattern").
// Counts, per file outside apps/web/src/ui, the router shell (shell/, routes/, main.tsx) and app.css (the DS sheet):
//   raw      raw <button> <input> <select> <textarea> <table> <a> in .tsx (the DS renders those);
//   dsClass  a DS-owned global class written by hand in a className string (btn, field__*, chip, card, table, alert,
//            notice, toolbar, tabs, page__head, kv, stat*, …) instead of rendering the component that owns it;
//   restyle  module-CSS declarations that restyle what a DS component owns: colour, background, border, radius,
//            font-size, font-weight anywhere; height, min-height, padding on a control (a selector naming a native
//            control, [aria-pressed] or :global(.btn/.field__input), or a class put on a DS control in the slice's
//            .tsx); and every :global( selector;
//   literal  a literal length (px, rem, em) or colour in a CSS value that is not a token: hairline borders and
//            outlines (1px … 3px) and @media conditions excepted.
// scripts/ds-baseline.json holds today's counts. They may only go down: a count above its pin fails, a count below
// fails too ("lower the baseline", in the same diff), and a file without a pin must count zero.
//   node scripts/check-ds.mjs              check (npm test runs it through scripts/gates.test.ts)
//   node scripts/check-ds.mjs --lower      rewrite pins that went down (never raises one)
//   node scripts/check-ds.mjs --admit f…   pin the named files at their current counts (INTEG only, for a branch
//                                          that was READY before this gate; the diff shows each admitted file)
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const METRICS = ["raw", "dsClass", "restyle", "literal"];
const APP = "apps/web/src";
const EXEMPT = /^apps\/web\/src\/(ui\/|shell\/|routes\/|main\.tsx$|app\.css$)/;
const RAW = /<(button|input|select|textarea|table|a)(?=[\s>/])/g;
const DS_CLASS = /^(btn(--[\w-]+)?|field(__[\w-]+)?|chip(--[\w-]+)?|card(__[\w-]+)?|table(__[\w-]+)?|alert|notice|toolbar(__[\w-]+)?|tabs|page__head|page__title|section-head|kv|stats?|stat__[\w-]+|state(__[\w-]+)?|panel__head|panel__title|listbox(__[\w-]+)?|combo(__[\w-]+)?|popover)$/;
const LOOK = /^(color|background(-color)?|border(-[\w-]+)?|font-size|font-weight)$/;
const BOX = /^(height|min-height|padding(-[\w-]+)?)$/;
const NATIVE_CONTROL = /(^|[\s>+~,(])(button|input|select|textarea|a)(?=[\s.:[>+~,)]|$)|\[aria-pressed|:global\(\.(btn|field__input)/;
const CONTROL_TAGS = "Button|ToggleButton|IconButton|TextInput|SelectInput|TextArea|DisabledReason|Chip";

const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");

/** raw and dsClass counts of one .tsx source. */
export function countTsx(src) {
  const raw = src.match(RAW)?.length ?? 0;
  let dsClass = 0;
  for (const m of src.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g))
    dsClass += (m[1] ?? m[2]).split(/\s+/).filter((c) => DS_CLASS.test(c)).length;
  return { raw, dsClass };
}

/** The module classes a .tsx puts on a DS control (`<Button className={s.pick}>`), which may not size it. */
export function controlClasses(src) {
  const re = new RegExp(`<(?:${CONTROL_TAGS})\\b[^>]*?className=\\{[^}]*?\\b\\w+\\.(\\w+)`, "g");
  return new Set([...src.matchAll(re)].map((m) => m[1]));
}

/** restyle and literal counts of one CSS source; `controls`: classes that sit on DS controls. */
export function countCss(css, controls = new Set()) {
  let restyle = 0;
  let literal = 0;
  // Flat walk: each `selector { body }`; an @media / @container wrapper's own braces are skipped over.
  for (const [, selector, body] of strip(css).matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    const sel = selector.trim();
    if (sel.startsWith("@")) continue;
    const onControl = NATIVE_CONTROL.test(sel) || [...controls].some((c) => new RegExp(`\\.${c}(?![\\w-])`).test(sel));
    if (sel.includes(":global(")) restyle++;
    for (const decl of body.split(";")) {
      const i = decl.indexOf(":");
      if (i < 0) continue;
      const prop = decl.slice(0, i).trim().toLowerCase();
      const value = decl.slice(i + 1).trim();
      if (!prop || prop.startsWith("--")) continue;
      if (LOOK.test(prop) || (onControl && BOX.test(prop))) restyle++;
      const hair = /^(border|outline)/.test(prop);
      for (const [n] of value.matchAll(/(?<![\w-])\d*\.?\d+(px|rem|em)\b/g)) if (!(hair && /^[123]px$/.test(n))) literal++;
      literal += value.match(/#[0-9a-f]{3,8}\b|\b(rgba?|hsla?)\(/gi)?.length ?? 0;
    }
  }
  return { restyle, literal };
}

const posix = (p) => p.split(path.sep).join("/");
function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/** Per-file counts under `root` (only nonzero metrics; files with none are left out). */
export function measure(root) {
  const files = walk(path.join(root, APP)).map((p) => posix(path.relative(root, p))).filter((f) => !EXEMPT.test(f));
  const counts = {};
  const add = (f, c) => {
    const nonzero = Object.fromEntries(Object.entries(c).filter(([, n]) => n > 0));
    if (Object.keys(nonzero).length) counts[f] = { ...counts[f], ...nonzero };
  };
  const tsx = files.filter((f) => f.endsWith(".tsx") && !/\.test\.tsx$/.test(f));
  const controlsByDir = new Map();
  for (const f of tsx) {
    const src = readFileSync(path.join(root, f), "utf8");
    add(f, countTsx(src));
    const dir = path.dirname(f);
    controlsByDir.set(dir, new Set([...(controlsByDir.get(dir) ?? []), ...controlClasses(src)]));
  }
  for (const f of files.filter((f) => f.endsWith(".css")))
    add(f, countCss(readFileSync(path.join(root, f), "utf8"), f.endsWith(".module.css") ? controlsByDir.get(path.dirname(f)) : undefined));
  return counts;
}

/** Problems of `counts` against `baseline` (empty = pass). */
const metricCount = (source, file, metric) => {
  if (!source || typeof source !== "object" || !Object.hasOwn(source, file)) return 0;
  const perFile = source[file];
  return perFile && typeof perFile === "object" && Object.hasOwn(perFile, metric)
    ? perFile[metric] ?? 0
    : 0;
};

export function compare(counts, baseline) {
  const problems = [];
  for (const f of new Set([...Object.keys(counts), ...Object.keys(baseline)])) {
    for (const m of METRICS) {
      const now = metricCount(counts, f, m);
      const pin = metricCount(baseline, f, m);
      if (now > pin)
        problems.push(`${f}: ${m} ×${now}, baseline ×${pin} — use the design-system component instead (docs/design/design-language.md §5)`);
      else if (now < pin) problems.push(`${f}: ${m} ×${now}, baseline ×${pin} — lower the baseline (node scripts/check-ds.mjs --lower)`);
    }
  }
  return problems;
}

const BASELINE = "scripts/ds-baseline.json";
// One file per line, sorted: two lanes lowering different files never touch the same line.
export const serialize = (o) => `{\n${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}: ${JSON.stringify(o[k])}`).join(",\n")}\n}\n`;

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const rootAt = args.indexOf("--root");
  const root = rootAt >= 0 ? args[rootAt + 1] : ".";
  const file = path.join(root, BASELINE);
  const baseline = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  const counts = measure(root);
  if (args.includes("--lower") || args.includes("--admit")) {
    const admit = args.includes("--admit") ? args.slice(args.indexOf("--admit") + 1).filter((a) => !a.startsWith("--")) : [];
    const next = {};
    for (const f of new Set([...Object.keys(baseline), ...admit])) {
      const pins = {};
      for (const m of METRICS) {
        const now = metricCount(counts, f, m);
        const pin = admit.includes(f) ? now : Math.min(now, metricCount(baseline, f, m));
        if (pin > 0) pins[m] = pin;
      }
      if (Object.keys(pins).length) next[f] = pins;
    }
    writeFileSync(file, serialize(next));
  }
  const problems = compare(counts, existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {});
  if (problems.length) {
    console.error(`design system: ${problems.length} problem(s):\n${problems.join("\n")}`);
    process.exit(1);
  }
}
