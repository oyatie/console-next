#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Proprietary
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const text = (value) => typeof value === "string" && value.trim().length > 0;
const date = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const key = (testId, projectName) => JSON.stringify([testId, projectName]);

/** Validate Playwright's JSON report against completed attempts, never its summary alone. */
export function checkEvidence(report, quarantine, now = new Date()) {
  const problems = [], quarantined = new Set(), seen = new Set();
  if (quarantine?.version !== 1 || !Array.isArray(quarantine.entries)
    || !Number.isFinite(quarantine.maxAgeHours) || quarantine.maxAgeHours <= 0) return ["invalid quarantine file or freshness policy"];
  for (const entry of quarantine.entries) {
    if (!entry || ![entry.testId, entry.projectName, entry.owner, entry.reason].every(text)
      || !date(entry.expires) || entry.expires < now.toISOString().slice(0, 10)) {
      problems.push("quarantine needs a test, project, owner, reason and unexpired date");
      continue;
    }
    const id = key(entry.testId, entry.projectName);
    if (quarantined.has(id)) problems.push(`duplicate quarantine: ${id}`);
    quarantined.add(id);
  }
  if (!report || !Array.isArray(report.suites) || !Array.isArray(report.errors) || !report.stats)
    return [...problems, "missing Playwright report, suites, errors or summary"];
  if (report.errors.length) problems.push("report has setup or runner errors");
  const age = now.getTime() - Date.parse(report.stats.startTime);
  if (!Number.isFinite(age) || age < 0 || age > quarantine.maxAgeHours * 60 * 60 * 1000)
    problems.push("report timestamp is missing, stale or in the future");
  const counts = { expected: 0, unexpected: 0, flaky: 0, skipped: 0 };
  function visit(suites) {
    for (const suite of suites) {
      if (!suite || typeof suite !== "object") { problems.push("invalid suite"); continue; }
      for (const spec of suite.specs ?? []) {
        if (!spec || !text(spec.id) || !Array.isArray(spec.tests) || !spec.tests.length) {
          problems.push("spec has no identity or tests");
          continue;
        }
        for (const test of spec.tests) {
          const id = key(spec.id, test?.projectName);
          if (!test || !text(test.projectName) || seen.has(id)) { problems.push(`missing or duplicate test: ${id}`); continue; }
          seen.add(id);
          if (!Object.hasOwn(counts, test.status)) { problems.push(`unknown test status: ${id}`); continue; }
          counts[test.status]++;
          if (!Array.isArray(test.results) || !test.results.length) { problems.push(`no attempts: ${id}`); continue; }
          if (test.status === "skipped" && quarantined.has(id)) {
            if (test.results.some((r) => r?.status !== "skipped" || r.error || r.errors?.length)) problems.push(`invalid skipped attempt: ${id}`);
            continue;
          }
          if (test.expectedStatus !== "passed" || test.status !== "expected"
            || test.results.some((r) => r?.status !== "passed" || r.error || r.errors?.length))
            problems.push(`test did not pass every attempt: ${id}`);
        }
      }
      if (suite.suites !== undefined) {
        if (Array.isArray(suite.suites)) visit(suite.suites);
        else problems.push("invalid child suites");
      }
    }
  }
  try { visit(report.suites); } catch { problems.push("malformed test tree"); }
  if (!seen.size) problems.push("no executed test evidence");
  if (!counts.expected) problems.push("no passing test execution");
  for (const [status, count] of Object.entries(counts)) {
    if (!Number.isSafeInteger(report.stats[status]) || report.stats[status] < 0 || report.stats[status] !== count)
      problems.push(`summary does not match test evidence: ${status}`);
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const [reportPath, ...extra] = process.argv.slice(2);
    if (!reportPath || extra.length) throw new Error("usage: node scripts/check-evidence.mjs <playwright-report.json>");
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    const quarantine = JSON.parse(readFileSync(new URL("./checks-quarantine.json", import.meta.url), "utf8"));
    const problems = checkEvidence(report, quarantine);
    if (problems.length) throw new Error(problems.join("\n"));
    process.stdout.write(`checks-evidence: complete; ${report.stats.expected} passed, ${report.stats.skipped} quarantined\n`);
  } catch (error) {
    process.stderr.write(`checks-evidence: ${error.message}\n`);
    process.exitCode = 1;
  }
}
