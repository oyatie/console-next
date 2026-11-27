#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from "node:assert/strict";
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function reportIdentities(suites) {
  const ids = [];
  function visit(suite) {
    for (const spec of suite.specs ?? []) for (const test of spec.tests ?? []) {
      assert.ok(spec.id && typeof test.projectName === "string", "missing Playwright test identity");
      ids.push(JSON.stringify([test.projectName, spec.id]));
    }
    for (const child of suite.suites ?? []) visit(child);
  }
  for (const suite of suites) visit(suite);
  assert.ok(ids.length && new Set(ids).size === ids.length, "empty or duplicate Playwright test inventory");
  return ids.sort();
}

export function specRows(reports) {
  const rows = new Map();
  const visit = (suite, inheritedFile) => {
    const file = suite.file ?? inheritedFile;
    for (const spec of suite.specs ?? []) for (const test of spec.tests ?? []) {
      const key = `${test.projectName}/${spec.file ?? file}`;
      const row = rows.get(key) ?? { spec: key, passed: 0, expectedFailures: 0, failed: 0, flaky: 0, skipped: 0, unexecuted: 0 };
      const interrupted = (test.results ?? []).some((result) => result.status === "interrupted");
      if (interrupted || (test.status === "skipped" && test.expectedStatus !== "skipped") || !test.status) row.unexecuted++;
      else if (test.status === "unexpected") row.failed++;
      else if (test.status === "flaky") row.flaky++;
      else if (test.status === "skipped") row.skipped++;
      else if (test.status === "expected" && test.results?.some(result => result.status === "failed") && test.expectedStatus === "failed") row.expectedFailures++;
      else if (test.status === "expected" && test.results?.some(result => result.status === "passed") && test.expectedStatus === "passed") row.passed++;
      else row.unexecuted++;
      rows.set(key, row);
    }
    for (const child of suite.suites ?? []) visit(child, file);
  };
  for (const report of reports) for (const suite of report.suites ?? []) visit(suite);
  if (!rows.size) throw new Error("live E2E reports contain no specs");
  return [...rows.values()].sort((a, b) => a.spec.localeCompare(b.spec));
}

export function markdown(rows) {
  return [
    "### Live E2E results by spec",
    "",
    "| Spec | Passed | Expected failures | Failed | Flaky | Skipped | Unexecuted |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...rows.map((row) => `| \`${row.spec}\` | ${row.passed} | ${row.expectedFailures} | ${row.failed} | ${row.flaky} | ${row.skipped} | ${row.unexecuted} |`),
    "",
  ].join("\n");
}

export const reportFailed = (reports, rows) =>
  reports.some((report) => (report.errors ?? []).length) || !rows.some(row => row.passed || row.expectedFailures) || rows.some((row) => row.failed || row.flaky || row.unexecuted);

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const files = process.argv.slice(2);
  let expected;
  if (files[0] === "--expected") {
    files.shift();
    expected = JSON.parse(readFileSync(files.shift(), "utf8"));
    assert.ok(Array.isArray(expected) && expected.length, "missing live shard discovery inventory");
  }
  const reports = files.map((file) => JSON.parse(readFileSync(file, "utf8")));
  if (expected) assert.deepEqual(reportIdentities(reports.flatMap(report => report.suites)), expected, "live shard test identities differ from discovery");
  const rows = specRows(reports);
  const summary = markdown(rows);
  process.stdout.write(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  if (reports.some(report => reportFailed([report], specRows([report])))) process.exitCode = 1;
}
