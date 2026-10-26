// SPDX-License-Identifier: LicenseRef-Proprietary
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "vitest";
// @ts-expect-error: plain .mjs gate
import { checkBrokenRefs, decodeIdent, measure, serialize } from "./check-ds.mjs";
const script = fileURLToPath(new URL("./check-ds.mjs", import.meta.url));
const tokenFile = "packages/tokens/tokens.css";
const tokens = readFileSync(new URL(`../${tokenFile}`, import.meta.url), "utf8");
const roots: string[] = [];
afterAll(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));
function fixture(files: Record<string, string>) {
  const root = mkdtempSync(path.join(tmpdir(), "ds-refs-"));
  roots.push(root);
  for (const [file, source] of Object.entries({ ...files, [tokenFile]: `${tokens}\n${files[tokenFile] ?? ""}` })) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), source);
  }
  // Isolate the reference contract from visual counts while keeping contrast enabled in the real CLI.
  mkdirSync(path.join(root, "scripts"));
  writeFileSync(path.join(root, "scripts/ds-baseline.json"), serialize(measure(root)));
  return root;
}
const gate = (root: string) => spawnSync("node", [script, "--root", root], { encoding: "utf8" });

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

test.each(["--pct", "--trigger-width", "--tree-item-level"])("runtime property %s is scoped to its consumers", (name) => {
  const r = gate(fixture({
    "apps/web/src/ui/meter/meter.module.css": `@property ${name} { syntax: "*"; inherits: true; } .fill { width: var(${name}); }`,
    "apps/web/src/ui/x/bad.module.css": `.bad { width: var(${name}); }`,
  }));
  expect(r.status, r.stderr).toBe(1);
  expect(r.stderr).toContain("1 problem(s)");
  expect(r.stderr).toContain(`apps/web/src/ui/x/bad.module.css: broken var reference var(${name})`);
});

test("token values are references: an alias of an undefined token fails in packages/tokens/tokens.css", () => {
  const r = gate(fixture({
    "packages/tokens/tokens.css": ":root { --surface: var(--nope); }",
    "apps/web/src/ui/x/ok.module.css": ".cell { outline: 2px solid var(--surface); }",
  }));
  expect(r.status, r.stderr).toBe(1);
  expect(r.stderr.match(/broken var reference/g)).toHaveLength(1);
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


test("non-root token declarations cannot define properties for other modules", () => {
  const root = fixture({
    "packages/tokens/tokens.css": ".component { --local: red; }",
    "apps/web/src/ui/x/bad.module.css": ".bad { color: var(--local); }",
  });
  expect(gate(root).stderr).toContain("var(--local)");
});

test("runtime TSX definitions belong only to their owner and imported CSS module", () => {
  for (const definition of ['el.style.setProperty("--pct", "60%");', 'const props = { "--pct": "60%" };']) {
    const root = fixture({
      "apps/web/src/ui/x/meter.tsx": `import s from "./meter.module.css"; ${definition} const style = { width: "var(--pct)" };`,
      "apps/web/src/ui/x/meter.module.css": ".fill { width: var(--pct); }",
      "apps/web/src/ui/x/other.module.css": ".bad { width: var(--pct); }",
    });
    const problems = checkBrokenRefs(root);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("other.module.css: broken var reference var(--pct)");
  }
});

test("quoted CSS strings and TSX comments cannot create references or definitions", () => {
  const root = fixture({
    "apps/web/src/ui/x/view.tsx": 'import s from "./view.module.css"; /* el.style.setProperty("--absent", "red") */ const label = "var(--missing)";',
    "apps/web/src/ui/x/view.module.css": '.a { content: "var(--quoted)"; color: var(--absent); }',
  });
  expect(checkBrokenRefs(root)).toHaveLength(2);
});
