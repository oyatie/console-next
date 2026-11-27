// The design-system gate (scripts/check-ds.mjs): what it counts, and that a regression fails it.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, test } from "vitest";
// @ts-expect-error: a plain .mjs script, no types
import { METRICS, checkBrokenRefs, compare, controlClasses, countCss, countTsx, frozenTokens, measure, serialize, styleSelectors } from "./check-ds.mjs";

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
  const counts = measure(root);
  expect(counts).toEqual({ [file]: { raw: 1, dsClass: 1 } });
  expect(compare(counts, { [file]: { raw: 0, dsClass: 0 } })).toHaveLength(2);
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
  const problems: string[] = checkBrokenRefs(root);
  expect(problems.some((p) => p.startsWith(tokenFile))).toBe(true);
  expect(problems.some((p) => p.startsWith("apps/web/src/ui/x.module.css"))).toBe(true);
  expect(problems.some((p) => p.startsWith("apps/web/src/shell/x.tsx"))).toBe(true);
  expect(problems.filter((p) => p.startsWith(cssFile))).toEqual([]);
});

test("only the shell reads its own sizes; everything else clears the frame through its insets", () => {
  const tokens = ":root { --rail-w: 1px; --topbar-h: 1px; --frame-top: var(--topbar-h); --space-4: 1px; }";
  const root = fixture({
    [tokenFile]: tokens,
    "apps/web/src/ui/toast/toast.module.css": ".t { left: calc(VAR(--rail-w) + var(--space-4)); }",
    "apps/web/src/ui/note.module.css": "/* never var(--rail-w) here */ .n { top: var(--frame-top); }",
    "apps/web/src/features/x/ui/x.tsx": 'const style = { top: "var(--topbar-h)" };',
    "apps/web/src/ui/ok.module.css": ".o { top: var(--frame-top); }",
    "apps/web/src/shell/top.module.css": ".a { max-width: var(--rail-w); }",
    "apps/web/src/app.css": ".shell { grid-template-columns: var(--rail-w) 1fr; }",
  }, {});
  const frame = (p: string) => p.includes("shell's size");
  expect(checkBrokenRefs(root).filter(frame).map((p: string) => p.split(":")[0]).sort())
    .toEqual(["apps/web/src/features/x/ui/x.tsx", "apps/web/src/ui/toast/toast.module.css"]);
  expect(gate(root).stderr.split("\n").filter(frame)).toHaveLength(2);
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

const repoTest = test.extend("repo", { scope: "file" }, () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const problems: string[] = [];
  const counts = measure(root, problems);
  const baseline = JSON.parse(readFileSync(path.join(root, "scripts/ds-baseline.json"), "utf8"));
  return { root, problems, pinProblems: compare(counts, baseline) };
});

repoTest("repo regression: refused outline, request divider and font weight resolve without fallback-only names", ({ repo }) => {
  const { root } = repo;
  expect(repo.problems).toEqual([]);
  expect(repo.pinProblems).toEqual([]);
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

repoTest("merged-tree metric pins are fully admitted", ({ repo }) => {
  expect(repo.pinProblems).toEqual([]);
});

const experienceFile = "packages/tokens/experiences/calm.css";
const calm = (light: string, dark = "") => `:root[data-experience="calm"] { ${light} }\n:root[data-experience="calm"][data-theme="dark"] { ${dark} }`;

test("literal token values in an experience file are not design-system debt", () => {
  const css = readFileSync(new URL("../packages/tokens/tokens.css", import.meta.url), "utf8");
  const r = gate(fixture({ [tokenFile]: css, [experienceFile]: calm("--border: #d0d7e0; --row-h: 36px;", "--border: #2b3542;") }, {}));
  expect(r.stderr).toBe("");
  expect(r.status).toBe(0);
});

test("check-ds runs the contrast pairs, the block rule and the dark rule on every experience file", () => {
  const css = readFileSync(new URL("../packages/tokens/tokens.css", import.meta.url), "utf8");
  const contrast = gate(fixture({ [tokenFile]: css, [experienceFile]: calm("", "--control-border: var(--surface);") }));
  expect(contrast.status).toBe(1);
  expect(contrast.stderr).toContain("experience calm, dark: --control-border/--surface 1.0000:1 < 3:1");
  const shape = gate(fixture({ [tokenFile]: css, [experienceFile]: ":root { --row-h: 36px; }" }));
  expect(shape.status).toBe(1);
  expect(shape.stderr).toContain(`${experienceFile}: :root is not one of the experience's blocks`);
  const lightOnly = gate(fixture({ [tokenFile]: css, [experienceFile]: calm("--border: #d0d7e0;") }));
  expect(lightOnly.status).toBe(1);
  expect(lightOnly.stderr).toContain(`${experienceFile}: --border is a colour set for light only`);
});

test("check-ds accepts an experience file's phone block of sizes and refuses a colour in it", () => {
  const css = readFileSync(new URL("../packages/tokens/tokens.css", import.meta.url), "utf8");
  const phone = (declarations: string) => `${calm("--border: #d0d7e0; --row-h: 28px;", "--border: #2b3542;")}\n@media (--phone) { :root[data-experience="calm"] { ${declarations} } }\n`;
  const sizes = gate(fixture({ [tokenFile]: css, [experienceFile]: phone("--row-h: 48px;") }, {}));
  expect(sizes.stderr).toBe("");
  expect(sizes.status).toBe(0);
  const colour = gate(fixture({ [tokenFile]: css, [experienceFile]: phone("--border: #111111;") }, {}));
  expect(colour.status).toBe(1);
  expect(colour.stderr).toContain(`${experienceFile}: --border is a colour in the phone block`);
});

const BASE_TOKENS = ':root { --surface: #ffffff; --primary: #2247d8; --focus: 0 0 0 2px var(--surface), 0 0 0 4px var(--primary); --row-h: 40px; }\n:root[data-theme="dark"] { --surface: #161c24; --primary: #6d8bff; }\n';

test("an existing token value may not change in either theme, and a token may not disappear", () => {
  expect(frozenTokens(BASE_TOKENS, BASE_TOKENS)).toEqual([]);
  const light = frozenTokens(BASE_TOKENS, BASE_TOKENS.replace("--row-h: 40px", "--row-h: 36px"));
  expect(light).toHaveLength(2);
  expect(light[0]).toContain("--row-h (light) was 40px, now 36px");
  const dark = frozenTokens(BASE_TOKENS, BASE_TOKENS.replace("--primary: #6d8bff", "--primary: #6fd3df"));
  // The dark primary also feeds the focus ring, which resolves through it.
  expect(dark.map((p: string) => p.split(" was ")[0])).toEqual(["packages/tokens/tokens.css: --primary (dark)", "packages/tokens/tokens.css: --focus (dark)"]);
  expect(frozenTokens(BASE_TOKENS, BASE_TOKENS.replace(" --row-h: 40px;", ""))[0]).toContain("--row-h (light) was 40px, now removed");
});

test("a new token, and an old token re-expressed through a new one at the same value, are not changes", () => {
  const added = BASE_TOKENS.replace("--row-h: 40px;", "--row-h: 40px; --control-h: 36px; --focus-ring: var(--primary);")
    .replace("4px var(--primary)", "4px var(--focus-ring)");
  expect(frozenTokens(BASE_TOKENS, added)).toEqual([]);
});

test("an intended change passes only at the value recorded for it", () => {
  const now = BASE_TOKENS.replace("--row-h: 40px", "--row-h: calc(36px + 4px)");
  expect(frozenTokens(BASE_TOKENS, now)).toHaveLength(2);
  const allowed = { "--row-h": { light: "calc(36px + 4px)", dark: "calc(36px + 4px)" } };
  expect(frozenTokens(BASE_TOKENS, now, allowed)).toEqual([]);
  expect(frozenTokens(BASE_TOKENS, now, Object.create(allowed))).toHaveLength(2);
  expect(frozenTokens(BASE_TOKENS, now.replace("36px + 4px", "30px + 4px"), allowed)).toHaveLength(2);
});

test("the gate compares the token file with the merge base and refuses a changed baseline value", () => {
  const real = readFileSync(fileURLToPath(new URL("../packages/tokens/tokens.css", import.meta.url)), "utf8");
  expect(real).toContain("--row-h: 40px");
  const root = fixture({ "packages/tokens/tokens.css": real });
  const git = (...args: string[]) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { cwd: root, encoding: "utf8" });
  expect(git("init", "-q", "-b", "dev").status).toBe(0);
  git("add", "-A");
  expect(git("commit", "-q", "-m", "base").status).toBe(0);
  git("switch", "-q", "-c", "change");
  const run = () => spawnSync("node", [script, "--root", root], { encoding: "utf8", env: { ...process.env, QUALITY_BASE: "dev" } });
  expect(run().stderr).toBe("");
  writeFileSync(path.join(root, "packages/tokens/tokens.css"), real.replace("--row-h: 40px", "--row-h: 36px"));
  const changed = run();
  expect(changed.status).toBe(1);
  expect(changed.stderr).toContain("--row-h (light) was 40px, now 36px");
  expect(changed.stderr).toContain("--row-h (dark) was 40px, now 36px");
  // A recorded change passes; the record is a file in the same diff, so a reader sees it.
  mkdirSync(path.join(root, "scripts"), { recursive: true });
  writeFileSync(path.join(root, "scripts/ds-token-changes.json"), JSON.stringify({ "--row-h": { light: "36px", dark: "36px" } }));
  expect(run().stderr).toBe("");
});

test("a rule may name a visual style only through the guard every new style shares", () => {
  const guard = ':where([data-experience]:not([data-experience="baseline"]))';
  const offending = (css: string) => styleSelectors(css, "x.css");
  // The accepted shape, as an ancestor, as a nesting parent, with the parent after it, and with single quotes.
  expect(offending(`${guard} .find { min-width: 0; }
    ${guard} { .keys { gap: 0; } @media (width < 768px) { .hint { display: none; } } }
    .top { ${guard} & { .jump { min-width: auto; } } }
    :where([data-experience]:not([data-experience='baseline'])) .a, ${guard} .b { gap: 0; }`)).toEqual([]);
  // A style named outright, the attribute alone, the guard without :where (it would add specificity), and a second
  // attribute test beside an accepted guard.
  expect(offending(`[data-experience="console"] .btn { gap: 0; }
    [data-experience] .btn { gap: 0; }
    [data-experience]:not([data-experience="baseline"]) .btn { gap: 0; }
    ${guard} .a, ${guard}[data-experience="warm-clear"] .b { gap: 0; }
    .ok { gap: 0; }`)).toEqual([
    '[data-experience="console"] .btn', "[data-experience] .btn", '[data-experience]:not([data-experience="baseline"]) .btn',
    `${guard}[data-experience="warm-clear"] .b`]);

  const named = gate(fixture({ "apps/web/src/features/x/ui/x.module.css": '[data-experience="console"] .row { gap: 0; }\n', "apps/web/src/ui/y/y.module.css": `${guard} .row { gap: 0; }\n` }, {}));
  expect(named.status).toBe(1);
  expect(named.stderr).toContain('apps/web/src/features/x/ui/x.module.css: [data-experience="console"] .row names a visual style');
  expect(named.stderr).not.toContain("y.module.css");
});
