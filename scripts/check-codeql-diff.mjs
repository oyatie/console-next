#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Proprietary
// Gate the analyzed merge commit using CodeQL's local SARIF, including fork PRs with read-only tokens.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const [directory, base] = process.argv.slice(2);
if (!directory || !/^[a-f0-9]{40}$/.test(base ?? "")) throw new Error("CodeQL requires a SARIF directory and base commit SHA");
const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const ancestor = git("merge-base", base, "HEAD").trim();
const entries = git("diff", "--no-ext-diff", "--no-textconv", "--find-renames", "--diff-filter=AMR", "--name-status", "-z", ancestor, "HEAD", "--").split("\0");
const changes = new Map();
for (let i = 0; entries[i];) {
  const status = entries[i++], before = entries[i++];
  const path = status.startsWith("R") ? entries[i++] : before;
  const revisions = status.startsWith("R") ? [`${ancestor}:${before}`, `HEAD:${path}`, "--"] : [ancestor, "HEAD", "--", path];
  const diff = git("diff", "--no-ext-diff", "--no-textconv", "--unified=0", ...revisions);
  const ranges = [...diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)]
    .map(([, start, count]) => [Number(start), Number(start) + Number(count ?? 1) - 1])
    .filter(([start, end]) => end >= start);
  changes.set(path, ranges);
}

const files = readdirSync(directory).filter((file) => file.endsWith(".sarif"));
if (!files.length) throw new Error("CodeQL produced no SARIF files");
const findings = [];
for (const file of files) {
  const sarif = JSON.parse(readFileSync(join(directory, file), "utf8"));
  if (sarif.version !== "2.1.0" || !Array.isArray(sarif.runs) || !sarif.runs.length) throw new Error("Invalid CodeQL SARIF runs");
  for (const run of sarif.runs) {
    const rules = [run.tool.driver, ...(run.tool.extensions ?? [])].flatMap((component) => component.rules ?? []);
    for (const result of run.results ?? []) {
      const rule = result.ruleId ? rules.find((candidate) => candidate.id === result.ruleId) : run.tool.driver.rules?.[result.ruleIndex];
      if (!rule) throw new Error("SARIF result has no matching rule");
      const score = rule.properties?.["security-severity"];
      if (score === undefined) continue;
      const severity = Number(score);
      if (score === "" || !Number.isFinite(severity) || severity < 0 || severity > 10) throw new Error("Invalid SARIF security severity");
      // GitHub's security-severity scale defines high/critical as CVSS >= 7.0.
      if (severity < 7) continue;
      if (!result.locations?.length) throw new Error("Security SARIF result has no location");
      for (const { physicalLocation: location } of result.locations) {
        const uri = location?.artifactLocation?.uri;
        if (!uri) throw new Error("Security SARIF result has no file URI");
        const path = relative(process.cwd(), fileURLToPath(new URL(uri, pathToFileURL(process.cwd() + sep)))).split(sep).join("/");
        const start = location.region?.startLine ?? 1;
        const end = location.region?.endLine ?? (location.region?.startLine ? start : Infinity);
        if (changes.get(path)?.some(([from, to]) => start <= to && end >= from)) findings.push(`${path}:${start}: ${rule.id} (security-severity ${score})`);
      }
    }
  }
}
if (findings.length) {
  console.error(`CodeQL: ${findings.length} high/critical finding(s) in changed lines:\n${findings.join("\n")}`);
  process.exitCode = 1;
} else {
  console.log(`CodeQL: no high/critical findings in changed lines (${files.length} SARIF file(s))`);
}
