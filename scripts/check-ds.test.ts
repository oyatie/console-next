// The design-system gate (scripts/check-ds.mjs): what it counts, and that a regression fails it.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
// @ts-expect-error: a plain .mjs script, no types
import { compare, controlClasses, countCss, countTsx, decodeIdent, measure, serialize } from "./check-ds.mjs";

const script = fileURLToPath(new URL("./check-ds.mjs", import.meta.url));

/** A throwaway repo root holding `files` (path → text) and, when given, a baseline. */
function fixture(files: Record<string, string>, baseline?: object) {
  const root = mkdtempSync(path.join(tmpdir(), "check-ds-"));
  for (const [f, text] of Object.entries({ ...files, ...(baseline ? { "scripts/ds-baseline.json": serialize(baseline) } : {}) })) {
    mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    writeFileSync(path.join(root, f), text);
  }
  return root;
}
const gate = (root: string) => spawnSync("node", [script, "--root", root], { encoding: "utf8" });
const RAW_BUTTON = 'export const Bad = () => <button className="btn" onClick={() => 1}>x</button>;\n';

test("a raw <button> in a feature view fails the gate (negative fixture)", () => {
  const r = gate(fixture({ "apps/web/src/features/x/ui/bad.tsx": RAW_BUTTON }, {}));
  expect(r.status).toBe(1);
  expect(r.stderr).toContain("apps/web/src/features/x/ui/bad.tsx: raw ×1, baseline ×0");
  expect(r.stderr).toContain("dsClass ×1, baseline ×0");
});

test("the same file inside ui/ or the router shell is the design system itself and passes", () => {
  const r = gate(fixture({ "apps/web/src/ui/x/ok.tsx": RAW_BUTTON, "apps/web/src/shell/ok.tsx": RAW_BUTTON, "apps/web/src/routes/ok.tsx": RAW_BUTTON }, {}));
  expect(r.stderr).toBe("");
  expect(r.status).toBe(0);
});

test("a pinned count may not rise, and a fall must lower the pin in the same diff", () => {
  const file = "apps/web/src/features/x/ui/bad.tsx";
  expect(gate(fixture({ [file]: RAW_BUTTON + RAW_BUTTON }, { [file]: { raw: 1, dsClass: 2 } })).stderr).toContain("raw ×2, baseline ×1");
  expect(gate(fixture({ [file]: "export const Ok = () => null;\n" }, { [file]: { raw: 1, dsClass: 1 } })).stderr).toContain("lower the baseline");
  expect(gate(fixture({ [file]: RAW_BUTTON }, { [file]: { raw: 1, dsClass: 1 } })).status).toBe(0);
});

test("compare ignores inherited file and metric counts", () => {
  const file = "apps/web/src/features/x/ui/bad.tsx";
  const baseline = { [file]: { raw: 1 } };
  const inheritedFileCounts = Object.create({ [file]: { raw: 1 } });
  const inheritedMetricCounts = { [file]: Object.create({ raw: 1 }) };

  expect(compare({ [file]: { raw: 1 } }, Object.create({ [file]: { raw: 1 } }))).toContain(
    `${file}: raw ×1, baseline ×0 — use the design-system component instead (docs/design/design-language.md §5)`,
  );
  expect(compare(inheritedFileCounts, baseline)).toContain(
    `${file}: raw ×0, baseline ×1 — lower the baseline (node scripts/check-ds.mjs --lower)`,
  );
  expect(compare(inheritedMetricCounts, baseline)).toContain(
    `${file}: raw ×0, baseline ×1 — lower the baseline (node scripts/check-ds.mjs --lower)`,
  );
});

test("--lower lowers pins and never raises one", () => {
  const file = "apps/web/src/features/x/ui/bad.tsx";
  const root = fixture({ [file]: RAW_BUTTON }, { [file]: { raw: 3, dsClass: 3 } });
  expect(spawnSync("node", [script, "--root", root, "--lower"], { encoding: "utf8" }).status).toBe(0);
  expect(measure(root)).toEqual({ [file]: { raw: 1, dsClass: 1 } });
  expect(compare(measure(root), { [file]: { raw: 0, dsClass: 0 } })).toHaveLength(2);
});

test("raw elements and hand-written DS classes are counted; utilities and components are not", () => {
  expect(countTsx('<a href="x">y</a><input /><table><Button className="row" /><span className="muted num grow">')).toEqual({ raw: 3, dsClass: 0 });
  expect(countTsx('<Link className="btn btn--primary" /><section className="card"><p className="alert">')).toEqual({ raw: 0, dsClass: 4 });
  expect(countTsx("<Banner /><abbr /><article />")).toEqual({ raw: 0, dsClass: 0 });
});

test("module CSS: look properties anywhere, box size only on controls, and every :global( restyle", () => {
  expect(countCss(".a { display: flex; gap: var(--space-2); }")).toEqual({ restyle: 0, literal: 0 });
  expect(countCss(".a { color: var(--steel); font-size: var(--text-sm); border: 1px solid var(--border); }")).toEqual({ restyle: 3, literal: 0 });
  expect(countCss(".a { padding: var(--space-3); min-height: var(--row-h); }")).toEqual({ restyle: 0, literal: 0 });
  expect(countCss(".a button { padding: 0; }  .b[aria-pressed] { height: var(--target); }")).toEqual({ restyle: 2, literal: 0 });
  expect(countCss(".a :global(.btn) { min-height: var(--target); }")).toEqual({ restyle: 2, literal: 0 });
  const controls = controlClasses('<Button className={s.pick}>x</Button><div className={s.box} />');
  expect([...controls]).toEqual(["pick"]);
  expect(countCss(".pick { padding: 0; } .box { padding: 0; }", controls)).toEqual({ restyle: 1, literal: 0 });
});

test("literals: lengths and colours in values count; hairlines, tokens and @media conditions do not", () => {
  expect(countCss(".a { width: 340px; grid-template-columns: 52px 1fr 2rem; }")).toEqual({ restyle: 0, literal: 3 });
  expect(countCss(".a { border-top: 1px solid var(--border); outline: 2px solid var(--primary); width: var(--panel-w); }")).toEqual({ restyle: 1, literal: 0 });
  expect(countCss("@media (max-width: 767px) { .a { display: none; } }")).toEqual({ restyle: 0, literal: 0 });
  expect(countCss(".a { box-shadow: 0 0 0 1px #fff; background: rgba(0, 0, 0, 0.1); }")).toEqual({ restyle: 1, literal: 3 });
});

test("fixture with var(--nope) defined nowhere fails, fallback-only var fails", () => {
  const r1 = gate(fixture({ "apps/web/src/features/x/ui/bad.module.css": ".bad { color: var(--nope); }" }, {}));
  expect(r1.status).toBe(1);
  expect(r1.stderr).toContain("var(--nope)");

  const r2 = gate(fixture({ "apps/web/src/features/x/ui/bad.module.css": ".bad { color: var(--nope, #000); }" }, {}));
  expect(r2.status).toBe(1);
  expect(r2.stderr).toContain("var(--nope)");
});

test.each([
  String.raw`.a{--a\ b:red;color:var(--a\ b)}`,
  String.raw`.a{--a\ b:red;color:var(--a\20 b)}`,
  String.raw`.a{--a\20 b:red;color:var(--a\ b)}`,
  `.a{--a\\\tb:red;color:var(--a\\\tb)}`,
])("escaped whitespace names resolve in local and token declarations: %s", (css) => {
  for (const file of ["apps/web/src/ui/x/ok.module.css", "packages/tokens/tokens.css"]) {
    const r = gate(fixture({ [file]: css }));
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toBe("");
  }
});

test("escaped whitespace names must still have a definition", () => {
  const r = gate(fixture({
    "apps/web/src/ui/x/bad.module.css": String.raw`.a{--ab:red;color:var(--a\ b,red)}`,
  }));
  expect(r.status, r.stderr).toBe(1);
  expect(r.stderr).toContain("broken var reference var(--a b)");
});

test.each([
  'export const label = "--nope";',
  '// "--nope"',
  '/* el.style.setProperty("--nope", "red"); */',
  'export const read = el.style.getPropertyValue("--nope");',
  'export const styles = { "--nope": "red" };',
  'el.style.setProperty("--nope", "red");',
])("unrelated TypeScript cannot define a CSS property: %s", (source) => {
  const r = gate(fixture({
    "apps/web/src/ui/x/bad.module.css": ".bad { color: var(--nope); }",
    "apps/web/src/unrelated.ts": source,
  }));
  expect(r.status, r.stderr).toBe(1);
  expect(r.stderr).toContain("var(--nope)");
});

test.each(["packages/tokens/tokens.css", "apps/web/src/ui/x/bad.module.css"])("commented declarations in %s do not define properties", (file) => {
  const r = gate(fixture({
    [file]: "/* --nope: red; */",
    "apps/web/src/ui/x/bad.module.css": `${file.endsWith("module.css") ? "/* --nope: red; */" : ""}.bad { color: var(--nope); }`,
  }));
  expect(r.status, r.stderr).toBe(1);
  expect(r.stderr).toContain("var(--nope)");
});

test.each(["--own", "--없는색"])("compact local and token declarations define %s", (prop) => {
  for (const definitions of [
    { "apps/web/src/ui/x/ok.module.css": `.ok{${prop}:red;color:var(${prop})}` },
    { "packages/tokens/tokens.css": `:root{${prop}:red}`, "apps/web/src/ui/x/ok.module.css": `.ok{color:var(${prop})}` },
  ]) {
    const r = gate(fixture(definitions));
    expect(r.status, r.stderr).toBe(0);
  }
});

test.each(["var(--없는색)", "var(--nope, currentColor)", "var(--own, var(--없는색))"])("undefined CSS identifiers and fallbacks fail: %s", (value) => {
  const r = gate(fixture({ "apps/web/src/ui/x/bad.module.css": `.bad{--own:red;color:${value}}` }));
  expect(r.status, r.stderr).toBe(1);
  expect(r.stderr).toContain(value.includes("없는색") ? "var(--없는색)" : "var(--nope)");
});

test("runtime properties are scoped to their consumers", () => {
  const r = gate(fixture({
    "apps/web/src/ui/meter/meter.module.css": ".fill { width: var(--pct); }",
    "apps/web/src/ui/x/bad.module.css": ".bad { width: var(--pct); }",
  }));
  expect(r.status, r.stderr).toBe(1);
  expect(r.stderr).toContain("1 problem(s)");
  expect(r.stderr).toContain("apps/web/src/ui/x/bad.module.css: broken var reference var(--pct)");
});

test("token values are references: an alias of an undefined token fails in packages/tokens/tokens.css", () => {
  const r = gate(fixture({
    "packages/tokens/tokens.css": ":root { --surface: var(--nope); }",
    "apps/web/src/ui/x/ok.module.css": ".cell { outline: 2px solid var(--surface); }",
  }));
  expect(r.status, r.stderr).toBe(1);
  expect(r.stderr).toContain("1 problem(s)");
  expect(r.stderr).toContain("packages/tokens/tokens.css: broken var reference var(--nope)");
});

test.each([
  [".cell { outline: 2px solid VAR(--nope); }", "var(--nope)"],
  [".cell { outline: 2px solid VaR(--nope, red); }", "var(--nope)"],
  [String.raw`.cell { outline: 2px solid var(\2d \2d nope); }`, "var(--nope)"],
  [String.raw`.cell { outline: 2px solid var(\-\-nope, red); }`, "var(--nope)"],
  [String.raw`.cell { outline: 2px solid v\000061r(--nope); }`, "var(--nope)"],
  [String.raw`.cell { outline: 2px solid v\61 r(--nope); }`, "var(--nope)"],
  [String.raw`.cell { outline: 2px solid \76 ar(--nope); }`, "var(--nope)"],
  [".cell { outline: 2px solid var(nope); }", "var(nope)"],
  // A plain property (`color`) is not a custom-property definition.
  [".a { color: red; outline: var(color); }", "var(color)"],
])("escaped, case-varied or non-custom names cannot bypass the reference check: %s", (css, name) => {
  const r = gate(fixture({ "apps/web/src/ui/x/bad.module.css": css }));
  expect(r.status, r.stderr).toBe(1);
  expect(r.stderr).toContain(`broken var reference ${name}`);
});

test.each([
  String.raw`.cell { --ink: red; outline: 2px solid var(--\69 nk); }`,
  String.raw`.cell { --\69 nk: red; outline: 2px solid var(--ink); }`,
  String.raw`.cell { --ink: red; outline: 2px solid v\000061r(--ink); }`,
  String.raw`.cell { --ink: red; outline: 2px solid v\61 r(--ink); }`,
  String.raw`.cell { --ink: red; outline: 2px solid \76 ar(--ink); }`,
  String.raw`.cell { --ink: red; outline: 2px solid var( /* c */ --ink /* c */ , blue); }`,
  String.raw`.cell { --ink: red; outline: 2px solid var(/**/--ink/**/); }`,
])("escaped names resolve to the property they spell: %s", (css) => {
  const r = gate(fixture({ "apps/web/src/ui/x/ok.module.css": css }));
  expect(r.stderr).toBe("");
  expect(r.status).toBe(0);
});

test("var as a font name or quoted string is not a var() function", () => {
  const r = gate(fixture({ "apps/web/src/ui/x/ok.module.css": '.cell { font-family: var; content: "var"; }' }));
  expect(r.stderr).toBe("");
  expect(r.status).toBe(0);
});

test.each(["apps/web/src/app.css", "apps/web/src/shell/shell.css", "apps/web/src/features/x/ui/plain.css"])(
  "plain stylesheets are checked too: %s",
  (file) => {
    const r = gate(fixture({ [file]: ".a { width: var(--nope); }" }));
    expect(r.status, r.stderr).toBe(1);
    expect(r.stderr).toContain(`${file}: broken var reference var(--nope)`);
  },
);

test("an undefined name repeated in one file is reported once per file", () => {
  const css = ".a { width: var(--nope); } .b { height: var(--nope, var(--nope)); }";
  const r = gate(fixture({ "apps/web/src/ui/x/a.module.css": css, "apps/web/src/ui/y/b.module.css": css }));
  expect(r.status, r.stderr).toBe(1);
  expect(r.stderr).toContain("2 problem(s)");
  expect(r.stderr).toContain("apps/web/src/ui/x/a.module.css: broken var reference var(--nope)");
  expect(r.stderr).toContain("apps/web/src/ui/y/b.module.css: broken var reference var(--nope)");
});

test("decodeIdent follows CSS escape rules, including invalid code points", () => {
  expect(decodeIdent(String.raw`\2d \2d x`)).toBe("--x");
  expect(decodeIdent(String.raw`\-\-x`)).toBe("--x");
  expect(decodeIdent(String.raw`--\69 nk`)).toBe("--ink");
  expect(decodeIdent("--\\69\r\nnk")).toBe("--ink");
  expect(decodeIdent(String.raw`\0 a\110000 b\d800 c`)).toBe("�a�b�c");
});
