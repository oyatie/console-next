// The design-system gate (scripts/check-ds.mjs): what it counts, and that a regression fails it.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, test } from "vitest";
// @ts-expect-error: a plain .mjs script, no types
import { METRICS, checkBrokenRefs, compare, controlClasses, countCss, countTsx, measure, serialize } from "./check-ds.mjs";

const script = fileURLToPath(new URL("./check-ds.mjs", import.meta.url));
const roots: string[] = [];
afterAll(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));

/** A throwaway repo root holding `files` (path → text) and, when given, a baseline. */
function fixture(files: Record<string, string>, baseline?: object) {
  const root = mkdtempSync(path.join(tmpdir(), "check-ds-"));
  roots.push(root);
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

const cssFile = "apps/web/src/features/x/view.module.css";
const tokenFile = "packages/tokens/tokens.css";
const tokens = ":root { --surface: #fff; --border: #777; --radius-lg: 10px; }";

test("piped gate output includes every problem before exiting", async () => {
  const files = Object.fromEntries(Array.from({ length: 1024 }, (_, i) => [
    `apps/web/src/features/x/${String(i).padStart(4, "0")}-${"view".repeat(32)}.tsx`, RAW_BUTTON,
  ]));
  const root = fixture(files);
  const expected = compare(measure(root), {});
  const result = await new Promise<{ status: number | null; stderr: string }>((resolve, reject) => {
    const child = spawn("node", [script, "--root", root], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.stderr.pause();
    const resume = setTimeout(() => child.stderr.resume(), 1000);
    child.on("error", reject);
    child.on("close", (status) => { clearTimeout(resume); resolve({ status, stderr }); });
  });
  expect(result.status).toBe(1);
  expect(result.stderr.split("\n")).toEqual([
    `design system: ${expected.length} problem(s):`, ...expected, "",
  ]);
});

test("check-ds enforces contrast in both themes even without metric violations", () => {
  const css = readFileSync(new URL("../packages/tokens/tokens.css", import.meta.url), "utf8");
  const good = gate(fixture({ [tokenFile]: css }));
  expect(good.status).toBe(0);
  expect(good.stderr).toBe("");
  for (const [theme, selector] of [["light", ":root"], ["dark", ':root[data-theme="dark"]']]) {
    const bad = gate(fixture({ [tokenFile]: `${css}\n${selector} { --control-border: var(--surface); }` }));
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain(`${theme}: --control-border/--surface 1.0000:1 < 3:1`);
    expect(bad.stderr).not.toContain("broken var reference");
  }
});

test("brokenRef refuses undefined refs even with a fallback, a baseline pin or --admit", () => {
  const root = fixture({ [cssFile]: ".a { outline: var(--missing, red); }" }, { [cssFile]: { brokenRef: 1 } });
  expect(checkBrokenRefs(root).join("\n")).toContain("var(--missing)");
  expect(gate(root).stderr).toContain("broken var reference");
  expect(spawnSync("node", [script, "--root", root, "--admit", cssFile], { encoding: "utf8" }).status).toBe(1);
  writeFileSync(path.join(root, cssFile), ".a { display: block; }");
  writeFileSync(path.join(root, "scripts/ds-baseline.json"), serialize({ [cssFile]: { brokenRef: 1 } }));
  expect(gate(root).stderr).toContain("brokenRef is a hard fail");
  expect(spawnSync("node", [script, "--root", root, "--lower"], { encoding: "utf8" }).status).toBe(1);
});

test("brokenRef checks UI, shell, tokens and inline styles, with same-module definitions allowed", () => {
  const root = fixture({
    [tokenFile]: ":root { --ink: var(--absent); }",
    "apps/web/src/ui/x.module.css": ".a { color: var(--ink); border-color: var(--absent); }",
    "apps/web/src/shell/x.tsx": 'const style = { color: "var(--absent)" };',
    [cssFile]: ".a { --local: 0; gap: var(--local); }",
  });
  expect(checkBrokenRefs(root).some((p: string) => p.startsWith(tokenFile))).toBe(true);
  expect(checkBrokenRefs(root).some((p: string) => p.startsWith("apps/web/src/ui/x.module.css"))).toBe(true);
  expect(checkBrokenRefs(root).some((p: string) => p.startsWith("apps/web/src/shell/x.tsx"))).toBe(true);
  expect(checkBrokenRefs(root).filter((p: string) => p.startsWith(cssFile))).toEqual([]);
});

test("dark-only and conditional definitions cannot satisfy light or unconditional refs", () => {
  for (const definition of [
    '@media (prefers-color-scheme: dark) { :root { --x: #000; } }',
    ':root[data-theme="dark"] { --x: #000; }',
    '@media (min-width: 640px) { :root { --x: #000; } }',
  ]) {
    const root = fixture({ [tokenFile]: definition, [cssFile]: ".a { color: var(--x); }" });
    expect(checkBrokenRefs(root).join("\n")).toContain("var(--x)");
    expect(gate(root).stderr).toContain("broken var reference");
  }
});

test("unconditional tokens and refs in matching dark/media contexts are valid", () => {
  const root = fixture({
    [tokenFile]: ':root { --all: #000; } @media (prefers-color-scheme: dark) { :root { --dark: #fff; } }',
    [cssFile]: '.a { color: var(--all); } @media (prefers-color-scheme: dark) { .a { color: var(--dark); } }',
  });
  expect(checkBrokenRefs(root).filter((p: string) => p.startsWith(cssFile))).toEqual([]);
});

// Every metric must trip its own fixture: an accidentally dead pattern fails this table.
const metricFixtures: Record<string, [string, string]> = {
  raw: ["view.tsx", "<button />"],
  dsClass: ["view.tsx", '<div className="btn" />'],
  restyle: ["view.module.css", ".a { color: var(--surface); }"],
  literal: ["view.module.css", ".a { width: 101px; }"],
};
const metricNearMisses: Record<string, string> = {
  raw: "<Button />", dsClass: '<div className="grow" />',
  restyle: ".a { display: flex; }", literal: ".a { width: var(--radius-lg); }",
};

test("every design-system metric has a live positive fixture and refuses a rise", () => {
  expect([...METRICS].sort()).toEqual(Object.keys(metricFixtures).sort());
  for (const metric of METRICS) {
    const [name, source] = metricFixtures[metric];
    const file = `apps/web/src/features/x/${name}`;
    const root = fixture({ [file]: source, [tokenFile]: tokens });
    const count = measure(root)[file]?.[metric] ?? 0;
    expect(count, metric).toBeGreaterThan(0);
    expect(compare({ [file]: { [metric]: count } }, {}), metric).not.toHaveLength(0);
    const nearMiss = fixture({ [file]: metricNearMisses[metric], [tokenFile]: tokens });
    expect(measure(nearMiss)[file]?.[metric] ?? 0, metric).toBe(0);
  }
});

test("repo regression: refused outline, request divider and font weight resolve without fallback-only names", () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const counts = measure(root);
  expect(checkBrokenRefs(root)).toEqual([]);
  expect(compare(counts, JSON.parse(readFileSync(path.join(root, "scripts/ds-baseline.json"), "utf8")))).toEqual([]);
  const css = readFileSync(path.join(root, "apps/web/src/ui/person-day-grid/person-day-grid.module.css"), "utf8");
  expect(css).toMatch(/\[data-look="refused"\][^{]*\{[^}]*outline: 2px solid var\(--danger-solid\)/);
  expect(css).toContain("font-weight: var(--fw-body)");
  expect(css).not.toMatch(/--(?:danger\)|fw-regular|att-hol|border-strong)|var\(--grid-code-w,/);
  expect(readFileSync(path.join(root, "apps/web/src/features/people/ui/requests.module.css"), "utf8")).toContain("var(--border)");
});

test("brokenRef sees declarations before nested rules and ignores quoted braces", () => {
  const root = fixture({ [cssFile]: '.a { color: var(--missing); &::before { content: "{}"; } }' });
  expect(checkBrokenRefs(root).join("\n")).toContain("var(--missing)");
});

test.each(["VAR(--nope)", String.raw`v\61 r(\2d \2d nope)`, "var(nope)", "var(--없는색)"])("CLI rejects broken lexer fixture %s exactly once", (value) => {
  const result = gate(fixture({ "apps/web/src/ui/x/bad.module.css": `.a { outline: 2px solid ${value}; }` }));
  expect(result.status, result.stderr).toBe(1);
  expect(result.stderr.match(/broken var reference/g)).toHaveLength(1);
});

test("merged-tree metric pins are fully admitted", () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const baseline = JSON.parse(readFileSync(path.join(root, "scripts/ds-baseline.json"), "utf8"));
  expect(compare(measure(root), baseline)).toEqual([]);
});
