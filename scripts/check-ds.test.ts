// The design-system gate (scripts/check-ds.mjs): what it counts, and that a regression fails it.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
// @ts-expect-error: a plain .mjs script, no types
import { compare, controlClasses, countCss, countTsx, measure, serialize } from "./check-ds.mjs";

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
