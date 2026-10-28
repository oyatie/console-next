// SPDX-License-Identifier: LicenseRef-Proprietary
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { inventory, inventoryProblems } from "./check-script-reachability.mjs";

const sources = {
  "package.json": JSON.stringify({ scripts: { check: "npm run guards && npm test", guards: "node scripts/check-live.mjs", test: "vitest run" } }),
  "vitest.config.ts": 'export default { test: { include: ["scripts/*.test.ts"] } };',
  ".github/workflows/ci.yml": "jobs:\n  web:\n    steps:\n      - run: npm run check\n",
  "scripts/check-live.mjs": 'import "./check-helper.mjs";',
  "scripts/check-helper.mjs": "export const helper = () => true;",
  "scripts/gates.test.ts": 'run("node", ["--test", "scripts/live.test.mjs"]);',
  "scripts/live.test.mjs": "",
  "scripts/dark.test.mjs": "",
  "scripts/check-dark.mjs": "",
};
const scan = (extra = {}) => {
  const files = { ...sources, ...extra };
  return inventory(Object.keys(files), file => files[file]);
};

test("inventory follows required CI, nested npm scripts, Vitest, subprocesses and imported helpers", () => {
  const rows = scan();
  expect(rows.filter(row => row.callers.length).map(row => row.file)).toEqual([
    "scripts/check-helper.mjs", "scripts/check-live.mjs", "scripts/live.test.mjs",
  ]);
  expect(inventoryProblems(rows, {})).toEqual([
    "scripts/check-dark.mjs: no caller from required CI",
    "scripts/dark.test.mjs: no caller from required CI",
  ]);
});

test("comments, expected strings, unused npm commands and non-required workflows are not callers", () => {
  const rows = scan({
    "scripts/gates.test.ts": '// run("node", ["scripts/check-dark.mjs"]);\nexpect(actual).toBe("scripts/check-dark.mjs");',
    "package.json": JSON.stringify({ scripts: { check: "npm test", test: "vitest run", unused: "node scripts/check-dark.mjs" } }),
    ".github/workflows/optional.yml": "jobs:\n  optional:\n    steps:\n      - run: node scripts/check-dark.mjs\n",
  });
  expect(rows.find(row => row.file === "scripts/check-dark.mjs")?.callers).toEqual([]);
});

test("importing exports does not count as executing a guarded check CLI", () => {
  const rows = scan({ "scripts/check-helper.mjs": 'if (process.argv[1] === fileURLToPath(import.meta.url)) check();' });
  expect(rows.find(row => row.file === "scripts/check-helper.mjs")?.callers).toEqual([]);
});

test("printing a command and shell comments do not execute a check", () => {
  const rows = scan({
    "package.json": JSON.stringify({ scripts: { check: "echo 'node scripts/check-dark.mjs && node scripts/check-dark.mjs' && npm test # ignored && node scripts/check-dark.mjs", test: "vitest run" } }),
  });
  expect(rows.find(row => row.file === "scripts/check-dark.mjs")?.callers).toEqual([]);
});

test("reusable CI workflows and Node test globs reach their suites", () => {
  const rows = scan({
    ".github/workflows/ci.yml": "jobs:\n  commits:\n    uses: ./.github/workflows/commits.yml\n",
    ".github/workflows/commits.yml": "jobs:\n  commits:\n    steps:\n      - run: |\n          node --test scripts/*.test.mjs\n",
  });
  expect(rows.filter(row => row.file.endsWith(".test.mjs")).every(row => row.callers.length > 0)).toBe(true);
});

test("a missing invoked npm command fails closed; cyclic scripts terminate", () => {
  expect(() => scan({ "package.json": '{"scripts":{"check":"npm run missing"}}' })).toThrow("missing npm script: missing");
  expect(() => scan({ "package.json": '{"scripts":{"check":"npm run check"}}' })).not.toThrow();
});

test("inherited orphans require reasons; removed or newly wired exceptions must leave the catalog", () => {
  const rows = scan();
  expect(inventoryProblems(rows, { "scripts/check-dark.mjs": "Inherited gate pending migration.", "scripts/dark.test.mjs": "Inherited suite pending repair." })).toEqual([]);
  expect(inventoryProblems(rows, { "scripts/check-dark.mjs": "" })).toContain("scripts/check-dark.mjs: orphan exception needs a reason");
  expect(inventoryProblems(rows, { "scripts/check-live.mjs": "old", "scripts/missing.test.mjs": "old" })).toEqual(expect.arrayContaining([
    "scripts/check-live.mjs: remove stale orphan exception",
    "scripts/missing.test.mjs: remove stale orphan exception",
  ]));
});

test("the inherited catalog cannot grow relative to dev", () => {
  const inherited = { "scripts/check-dark.mjs": "existing", "scripts/dark.test.mjs": "new" };
  expect(inventoryProblems(scan(), inherited, { "scripts/check-dark.mjs": "existing" })).toEqual([
    "scripts/dark.test.mjs: orphan catalog must only shrink",
  ]);
});

test("the required check has no unexplained orphan and runs the lifecycle contract suite", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const files = execFileSync("git", ["ls-files", "-co", "--exclude-standard"], { cwd: root, encoding: "utf8" }).trim().split("\n");
  const rows = inventory(files, file => readFileSync(path.join(root, file), "utf8"));
  const inherited = JSON.parse(readFileSync(path.join(root, "scripts/script-reachability-baseline.json"), "utf8")).orphans;
  expect(inventoryProblems(rows, inherited)).toEqual([]);
  expect(rows.find(row => row.file === "scripts/lifecycle-correction-contract.test.mjs")?.callers.length).toBeGreaterThan(0);
});

test("CLI refuses a planted orphan in the candidate worktree", () => {
  const root = mkdtempSync(path.join(tmpdir(), "script-reachability-"));
  try {
    execFileSync("git", ["init", "-q", root]);
    writeFileSync(path.join(root, "package.json"), '{"scripts":{"check":""}}');
    mkdirSync(path.join(root, ".github/workflows"), { recursive: true });
    writeFileSync(path.join(root, ".github/workflows/ci.yml"), "jobs:\n  web:\n    steps:\n      - run: npm run check\n");
    // A candidate need not be committed or staged for the inventory to catch it.
    writeFileSync(path.join(root, "planted.test.mjs"), "");
    const result = spawnSync(process.execPath, [path.join(import.meta.dirname, "check-script-reachability.mjs"), "--root", root], { encoding: "utf8" });
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).toContain("planted.test.mjs: no caller from required CI");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
