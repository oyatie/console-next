#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Proprietary
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function specRows(reports) {
  const rows = new Map();
  const visit = (suite, inheritedFile) => {
    const file = suite.file ?? inheritedFile;
    for (const spec of suite.specs ?? []) for (const test of spec.tests ?? []) {
      const key = `${test.projectName}/${spec.file ?? file}`;
      const row = rows.get(key) ?? { spec: key, passed: 0, failed: 0, flaky: 0, skipped: 0, unexecuted: 0 };
      const interrupted = (test.results ?? []).some((result) => result.status === "interrupted");
      if (interrupted || (test.status === "skipped" && test.expectedStatus !== "skipped") || !test.status) row.unexecuted++;
      else if (test.status === "unexpected") row.failed++;
      else if (test.status === "flaky") row.flaky++;
      else if (test.status === "skipped") row.skipped++;
      else row.passed++;
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
    "| Spec | Passed | Failed | Flaky | Skipped | Unexecuted |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
    ...rows.map((row) => `| \`${row.spec}\` | ${row.passed} | ${row.failed} | ${row.flaky} | ${row.skipped} | ${row.unexecuted} |`),
    "",
  ].join("\n");
}

export const reportFailed = (reports, rows) =>
  reports.some((report) => (report.errors ?? []).length) || rows.some((row) => row.failed || row.flaky || row.unexecuted);

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const reports = process.argv.slice(2).map((file) => JSON.parse(readFileSync(file, "utf8")));
  const rows = specRows(reports);
  const summary = markdown(rows);
  process.stdout.write(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  if (reportFailed(reports, rows)) process.exitCode = 1;
}
