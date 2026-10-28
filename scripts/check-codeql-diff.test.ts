// SPDX-License-Identifier: LicenseRef-Proprietary
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, test } from "vitest";

const script = resolve("scripts/check-codeql-diff.mjs");
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "codeql-diff-")));
  roots.push(root);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.name", "Jason Lee");
  git("config", "user.email", "56489493+jason931225@users.noreply.github.com");
  git("config", "core.hooksPath", "/dev/null");
  const file = "한 글.ts";
  writeFileSync(join(root, file), "unchanged\nreplaced\ntail\n");
  git("add", ".");
  git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  writeFileSync(join(root, file), "unchanged\nchanged\nadded\ntail\n");
  git("add", ".");
  git("commit", "-qm", "change");
  const results = join(root, "results");
  mkdirSync(results);
  const run = (document: object, comparison = base) => {
    writeFileSync(join(results, "javascript.sarif"), JSON.stringify(document));
    return spawnSync(process.execPath, [script, results, comparison], { cwd: root, encoding: "utf8" });
  };
  return { root, file, git, base, results, run };
}

function sarif(uri: string, severity: string | undefined = "7.0", line = 2, endLine = line) {
  return {
    version: "2.1.0",
    runs: [{
      tool: { driver: { name: "CodeQL", rules: [{ id: "js/planted", properties: { "security-severity": severity } }] } },
      results: [{ ruleId: "js/planted", locations: [{ physicalLocation: {
        artifactLocation: { uri, uriBaseId: "%SRCROOT%" }, region: { startLine: line, endLine },
      } }] }],
    }],
  };
}

test.each(["7.0", "8.9", "9.0", "10.0"])("rejects a planted %s security finding on added lines", (severity) => {
  const f = fixture();
  const result = f.run(sarif(encodeURI(f.file), severity));
  expect(result.status, result.stderr).toBe(1);
  expect(result.stderr).toContain(`${f.file}:2: js/planted`);
});

test.each(["6.9", "4.0", "0.0", undefined])("passes a lower or non-security severity %s", (severity) => {
  const f = fixture();
  const document = sarif(encodeURI(f.file), severity);
  if (severity === undefined) document.runs[0].tool.driver.rules[0].properties = {};
  expect(f.run(document).status).toBe(0);
});

test("ignores unchanged lines and files, and detects a region overlapping an added line", () => {
  const f = fixture();
  expect(f.run(sarif(encodeURI(f.file), "9.8", 1)).status).toBe(0);
  expect(f.run(sarif("other.ts", "9.8")).status).toBe(0);
  expect(f.run(sarif(encodeURI(f.file), "9.8", 1, 2)).status).toBe(1);
  expect(f.run(sarif(pathToFileURL(join(f.root, f.file)).href, "9.8", 3)).status).toBe(1);
});

test.each(["6.9", "7.0", "9.8"])("checks a new data-flow source with an unchanged sink at severity %s", (severity) => {
  const f = fixture();
  const document = sarif(encodeURI(f.file), severity, 1);
  const run = document.runs[0];
  const source = sarif(encodeURI(f.file), severity).runs[0].results[0].locations[0];
  const result = f.run({ ...document, runs: [{ ...run, results: [{
    ...run.results[0],
    codeFlows: [{ threadFlows: [{ locations: [
      { location: { message: { text: "sensitive flow value" } } },
    ] }] }, { threadFlows: [{ locations: [{ location: source }] }] }],
  }] }] });
  expect(result.status, result.stderr).toBe(severity === "6.9" ? 0 : 1);
  if (severity !== "6.9") expect(result.stderr).toContain(`${f.file}:2: js/planted`);
  expect(result.stderr).not.toContain("sensitive flow value");
});

test("an entirely unchanged data flow does not fail the diff gate", () => {
  const f = fixture();
  const document = sarif(encodeURI(f.file), "9.8", 1);
  const run = document.runs[0];
  expect(f.run({ ...document, runs: [{ ...run, results: [{
    ...run.results[0],
    codeFlows: [{ threadFlows: [{ locations: [
      { location: run.results[0].locations[0] },
      { location: sarif("other.ts").runs[0].results[0].locations[0] },
    ] }] }],
  }] }] }).status).toBe(0);
});

test("uses the merge base, excluding unrelated target changes", () => {
  const f = fixture();
  f.git("checkout", "-qb", "target", f.base);
  writeFileSync(join(f.root, "target.ts"), "target-only\n");
  f.git("add", ".");
  f.git("commit", "-qm", "target");
  const target = f.git("rev-parse", "HEAD");
  f.git("checkout", "-q", "-");
  expect(f.run(sarif("target.ts", "9.8", 1), target).status).toBe(0);
  expect(f.run(sarif(encodeURI(f.file)), target).status).toBe(1);
});

test("finds added files and renamed files without parsing quoted git paths", () => {
  const f = fixture();
  f.git("mv", f.file, "renamed.ts");
  writeFileSync(join(f.root, "new.ts"), "new\n");
  f.git("add", ".");
  f.git("commit", "-qm", "rename and add");
  expect(f.run(sarif("renamed.ts")).status).toBe(1);
  expect(f.run(sarif("new.ts", "9.8", 1)).status).toBe(1);
});

test("a pure rename and a deletion do not introduce changed lines", () => {
  const f = fixture();
  const base = f.git("rev-parse", "HEAD");
  f.git("mv", f.file, "rename-only.ts");
  f.git("commit", "-qm", "rename only");
  expect(f.run(sarif("rename-only.ts"), base).status).toBe(0);
  writeFileSync(join(f.root, "rename-only.ts"), "unchanged\nadded\ntail\n");
  f.git("add", ".");
  f.git("commit", "-qm", "delete one line");
  expect(f.run(sarif("rename-only.ts", "9.8", 2), base).status).toBe(0);
});

test("reads extension rule metadata and ruleIndex results", () => {
  const f = fixture();
  const document = sarif(encodeURI(f.file));
  const driver = document.runs[0].tool.driver;
  const result = document.runs[0].results[0];
  const indexed = { ...document, runs: [{ ...document.runs[0], results: [{ ...result, ruleId: undefined, ruleIndex: 0 }] }] };
  expect(f.run(indexed).status).toBe(1);
  const extended = { ...document, runs: [{ ...document.runs[0], tool: { driver: { ...driver, rules: [] }, extensions: [driver] } }] };
  expect(f.run(extended).status).toBe(1);
});

test("accepts a successful scan without findings", () => {
  const f = fixture();
  const document = sarif(encodeURI(f.file));
  document.runs[0].results = [];
  expect(f.run(document).status).toBe(0);
});

test.each([{}, { version: "2.1.0", runs: [] }, sarif("x", "invalid")])("fails closed on invalid scan evidence %j", (document) => {
  const f = fixture();
  const result = f.run(document);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toMatch(/SARIF|severity/);
});

test("fails closed on missing results, an invalid comparison and unknown rules", () => {
  const f = fixture();
  const missing = spawnSync(process.execPath, [script, f.results, f.base], { cwd: f.root, encoding: "utf8" });
  expect(missing.status).not.toBe(0);
  expect(missing.stderr).toContain("SARIF");
  expect(f.run(sarif(encodeURI(f.file)), "bad-ref").status).not.toBe(0);
  const document = sarif(encodeURI(f.file));
  document.runs[0].tool.driver.rules = [];
  const unknown = f.run(document);
  expect(unknown.status).not.toBe(0);
  expect(unknown.stderr).toContain("rule");
});
