import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { afterAll, expect, test } from "vitest";
import { clones } from "./quality/clones.mjs";
import { patterns } from "./quality/patterns.mjs";
import { deadCode } from "./quality/dead-code.mjs";
import { ratchet, baselineGrowth } from "./quality/ratchet.mjs";
import { checkDependencyNotes } from "./check-deps.mjs";

const repo = path.resolve(import.meta.dirname, "..");
const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const put = (dir: string, file: string, text: string) => {
  mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  writeFileSync(path.join(dir, file), text);
};

function fixture(files: Record<string, string>) {
  const root = mkdtempSync(path.join(repo, ".quality-"));
  dirs.push(root);
  for (const dir of ["apps/web/src", "packages/api/src", "packages/i18n/src", "e2e", "scripts/quality"]) mkdirSync(path.join(root, dir), { recursive: true });
  put(root, "tsconfig.json", JSON.stringify({ compilerOptions: { noLib: true, module: "ESNext", moduleResolution: "bundler" }, include: ["apps", "packages", "e2e"] }));
  put(root, "package.json", '{"name":"fixture","workspaces":["apps/*","packages/*"]}');
  put(root, "package-lock.json", '{"packages":{}}');
  put(root, "scripts/quality/dependency-verification.json", "{}");
  put(root, "scripts/quality/baseline.json", "{}");
  put(root, "apps/web/src/main.tsx", "export {};\n");
  const git = (args: string[]) => {
    const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
  };
  git(["init", "--quiet", "-b", "fixture-base"]);
  git(["add", "."]);
  git(["-c", "user.name=Jason Lee", "-c", "user.email=56489493+jason931225@users.noreply.github.com", "-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "test: create isolated quality fixture"]);
  Object.entries(files).forEach(([file, text]) => put(root, file, text));
  return root;
}

function parse(files: Record<string, string>) {
  const root = fixture(files);
  const paths = Object.keys(files).map((f) => path.join(root, f));
  const program = ts.createProgram(paths, { noLib: true, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler });
  const sources = paths.map((f) => program.getSourceFile(f)!);
  const relative = (file: string) => path.relative(root, file);
  return { sources, checker: program.getTypeChecker(), relative };
}

const repeated = Array.from({ length: 14 }, (_, i) => `total += costs[${i}] * rates[${i}];`).join("\n");
test("clone control: copied token blocks fail; whitespace/comments do not hide them", () => {
  const found = clones([{ file: "a.ts", text: repeated }, { file: "b.ts", text: repeated.replaceAll(" += ", "/* copied */+=") }]);
  expect(Object.keys(found)).toHaveLength(1);
  expect(ratchet(found, {})).toContainEqual(expect.stringContaining("new debt"));
  expect(clones([{ file: "a.ts", text: repeated }])).toEqual({});
  expect(clones([{ file: "a.ts", text: "x();" }, { file: "b.ts", text: "x();" }])).toEqual({});
});

test.each([
  ["empty-catch", "apps/web/src/main.tsx", "try { write(); } catch (e) { /* hidden */ }"],
  ["todo", "apps/web/src/main.tsx", "// TODO: finish the save\nexport {};"],
  ["assertionless-test", "apps/web/src/rule.test.ts", 'test("does nothing", () => { rule(); });'],
  ["snapshot-only-logic", "apps/web/src/rule.test.ts", 'test.each([1])("logic", () => { expect(rule()).toMatchInlineSnapshot(); });'],
])("%s control refuses its planted example", (rule, file, text) => {
  const p = parse({ [file]: text });
  const found = patterns(p.sources, p.checker, p.relative);
  expect(Object.keys(found)).toContainEqual(expect.stringMatching(new RegExp(`^${rule}:`)));
  expect(ratchet(found, {})).not.toEqual([]);
});

test("handled catches, literal TODO text, behavioral and shared-helper assertions pass", () => {
  const p = parse({
    "apps/web/src/main.tsx": 'try { write(); } catch (e) { throw e; } const label = "TODO";',
    "apps/web/src/helper.ts": 'export function check(v) { expect(v).toBe(2); }',
    "apps/web/src/rule.test.ts": 'import { check } from "./helper"; test("helper", () => check(rule())); test("both", () => { expect(rule()).toMatchSnapshot(); expect(rule()).toBe(2); });',
    "apps/web/src/ui/view.test.tsx": 'test("render", () => expect(render()).toMatchSnapshot());',
    "e2e/view.spec.ts": 'test("visual", () => expect(page).toHaveScreenshot());',
  });
  expect(patterns(p.sources, p.checker, p.relative)).toEqual({});
});

test("registration/assertion aliases and named callbacks keep assertion controls effective", () => {
  const p = parse({
    "apps/web/src/alias.test.ts": 'import { test as scenario, expect as check } from "vitest"; function verifies() { check(2).toBe(2); } function empty() { calculate(); } scenario("good", verifies); scenario("bad", empty);',
    "apps/web/src/assert.test.ts": 'import scenario from "node:test"; import strict from "node:assert/strict"; scenario("assert", () => strict.equal(2, 2));',
  });
  const found = patterns(p.sources, p.checker, p.relative);
  expect(Object.keys(found)).toHaveLength(1);
  expect(Object.keys(found)[0]).toMatch(/^assertionless-test:apps\/web\/src\/alias.test.ts:/);
});

test("dead-file/export controls fail, live imports/re-exports/literal dynamic imports/globs pass", () => {
  const p = parse({
    "apps/web/src/main.tsx": 'import { value } from "./bridge"; value(); import("./lazy"); import.meta.glob("./*.gallery.tsx", { eager: true });',
    "apps/web/src/bridge.ts": 'export { value } from "./values";',
    "apps/web/src/values.ts": 'export function value() {} export const forgotten = 1;',
    "apps/web/src/lazy.ts": 'export {};',
    "apps/web/src/view.gallery.tsx": 'export default function View() {} export const order = 1;',
    "apps/web/src/orphan.ts": 'export const orphan = 2;',
  });
  expect(deadCode(p.sources, p.checker, p.relative)).toEqual({
    "unused-export:apps/web/src/values.ts:forgotten": 1,
    "dead-file:apps/web/src/orphan.ts": 1,
  });
});

test("lazy routes read their named export and still reject unused siblings and wrong names", () => {
  const p = parse({
    "apps/web/src/main.tsx": 'declare function screen(f: unknown): unknown; declare function lazyRouteComponent(f: unknown, name: string): unknown; const load = () => import("./page"); lazyRouteComponent(screen(load), "Page"); lazyRouteComponent(() => import("./wrong"), "Missing");',
    "apps/web/src/page.ts": 'export function Page() {} export function Unused() {}',
    "apps/web/src/wrong.ts": 'export function Other() {}',
  });
  expect(deadCode(p.sources, p.checker, p.relative)).toEqual({
    "unused-export:apps/web/src/page.ts:Unused": 1,
    "unused-export:apps/web/src/wrong.ts:Other": 1,
  });
});

test("ratchet controls reject additions, extra occurrences, stale entries and baseline growth", () => {
  expect(ratchet({ x: 1 }, { x: 1 })).toEqual([]);
  expect(ratchet({ x: 2 }, { x: 1 })).toHaveLength(1);
  expect(ratchet({}, { x: 1 })).toHaveLength(1);
  expect(ratchet({ y: 1 }, { x: 1 })).toHaveLength(2);
  expect(ratchet({ x: 1 }, { x: -1 })).toHaveLength(1);
  expect(baselineGrowth({ x: 1 }, {})).toHaveLength(1);
  expect(baselineGrowth({ x: 2 }, { x: 1 })).toHaveLength(1);
  expect(baselineGrowth({}, { x: 1 })).toEqual([]);
});

const manifests = [{ file: "package.json", json: { dependencies: { example: "^1" } } }];
const verification = {
  "package.json:dependencies:example": { requirement: "^1", version: "1.2.3", registry: "https://registry.npmjs.org/example/1.2.3", checked: "2026-10-12", note: "docs/quality/dependencies/example.md" },
};
const lock = { packages: { "node_modules/example": { version: "1.2.3", integrity: "fixture-integrity" } } };
const noteText = "Reason: installed alternative evaluated\nProvenance: registry and upstream checked\nLicense: MIT reviewed\nSecurity: advisories reviewed";
test("dependency control: notes bind added/changed requirements to exact lock versions and review", () => {
  expect(checkDependencyNotes(manifests, {}, {}, lock, () => noteText)).toHaveLength(1);
  expect(checkDependencyNotes(manifests, {}, verification, lock, () => noteText)).toEqual([]);
  expect(checkDependencyNotes(manifests, {}, verification, lock, () => "unreviewed")).toHaveLength(1);
  expect(checkDependencyNotes(manifests, {}, verification, { packages: {} }, () => noteText)).toHaveLength(1);
  expect(checkDependencyNotes(manifests, { "package.json": { dependencies: { example: "^1" } } }, {}, lock, () => "")).toEqual([]);
  expect(checkDependencyNotes(manifests, { "package.json": { dependencies: { example: "^0" } } }, {}, lock, () => "")).toHaveLength(1);
});

test("CLI control: pass fixture → planted refusal → baseline laundering refusal → restored pass", () => {
  const root = fixture({});
  const cli = (args: string[] = []) => spawnSync("node", [path.join(repo, "scripts/check-ai-quality.mjs"), "--root", root, "--base", "fixture-base", ...args], { encoding: "utf8" });
  expect(cli().status).toBe(0);
  put(root, "apps/web/src/main.tsx", "try { write(); } catch {}\n");
  const refused = cli();
  expect(refused.status).toBe(1);
  expect(refused.stderr).toContain("empty-catch:");
  const report = cli(["--report"]);
  expect(report.status).toBe(0);
  put(root, "scripts/quality/baseline.json", report.stdout);
  expect(cli().stderr).toContain("baseline must only shrink");
  put(root, "apps/web/src/main.tsx", "export {};\n");
  put(root, "scripts/quality/baseline.json", "{}");
  expect(cli().status).toBe(0);
  expect(cli(["--base", "missing-ref"]).status).toBe(1);
  rmSync(path.join(root, "scripts/quality/baseline.json"));
  expect(cli().status).toBe(1);
}, 20000);
