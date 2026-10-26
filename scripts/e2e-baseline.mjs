// SPDX-License-Identifier: LicenseRef-Proprietary
// Collect on the verifier's two-core Linux runner; never infer CI timings from a developer machine.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, platform } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];
const distribution = (values) => ({ p50: percentile(values, 0.5), p95: percentile(values, 0.95) });

export function summarize(report, wall_ms) {
  if (report.config?.workers !== 2) throw new Error("baseline requires two workers");
  if (report.errors?.length || !report.suites?.length) throw new Error("incomplete run: runner/setup error or no suites");
  const specs = {}, coverage = [];
  let executed = 0, flaky = 0, failed = 0;
  const visit = (suite, titles = []) => {
    for (const spec of suite.specs ?? []) for (const test of spec.tests) {
      coverage.push([test.projectName, spec.file ?? suite.file, ...titles, spec.title].join("/"));
      if (test.status === "skipped") {
        if (test.expectedStatus !== "skipped") throw new Error("incomplete run: unexecuted test");
        continue;
      }
      if (!test.results?.length || test.results.some((r) => r.status === "interrupted")) throw new Error("incomplete run: interrupted/missing result");
      executed++;
      flaky += Number(test.status === "flaky");
      failed += Number(test.status === "unexpected");
      const key = `${test.projectName}/${spec.file ?? suite.file}`;
      specs[key] = (specs[key] ?? 0) + test.results.reduce((sum, result) => sum + result.duration, 0);
    }
    for (const child of suite.suites ?? []) visit(child, [...titles, child.title]);
  };
  report.suites.forEach((suite) => visit(suite));
  if (!executed || !Number.isFinite(wall_ms) || wall_ms <= 0) throw new Error("incomplete run: no executions or invalid wall time");
  return { wall_ms, executed, flaky, failed, flake_rate: flaky / executed, specs, coverage: coverage.sort() };
}

export function aggregate(runs) {
  if (runs.length !== 3) throw new Error("baseline requires exactly three complete runs per browser");
  if (runs.some((run) => JSON.stringify(run.coverage) !== JSON.stringify(runs[0].coverage))) throw new Error("baseline coverage differs between runs");
  if (runs.some((run) => Object.keys(run.specs).sort().join("\n") !== Object.keys(runs[0].specs).sort().join("\n"))) throw new Error("baseline executed coverage differs between runs");
  const executed = runs.reduce((sum, run) => sum + run.executed, 0);
  return {
    wall_ms: distribution(runs.map((run) => run.wall_ms)),
    flake_rate: runs.reduce((sum, run) => sum + run.flaky, 0) / executed,
    failed: runs.map((run) => run.failed),
    specs: Object.fromEntries(Object.keys(runs[0].specs).sort().map((file) => [file, distribution(runs.map((run) => run.specs[file]))])),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (platform() !== "linux" || availableParallelism() !== 2) throw new Error("collect baseline on a Linux runner allocated exactly two cores");
  const root = fileURLToPath(new URL("..", import.meta.url));
  const output = path.resolve(process.argv[2] ?? "reports/e2e-baseline");
  mkdirSync(output, { recursive: true });
  const git = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  if (git.status !== 0) throw new Error(git.stderr);
  const evidence = { revision: git.stdout.trim(), at: new Date().toISOString(), cores: availableParallelism(), browsers: {} };
  let red = false;
  for (const browser of ["chromium", "firefox"]) {
    const runs = [];
    for (let i = 1; i <= 3; i++) {
      const reportFile = path.join(output, `${browser}-${i}.json`);
      rmSync(reportFile, { force: true });
      const started = performance.now();
      const result = spawnSync(process.execPath, [path.join(root, "node_modules/@playwright/test/cli.js"), "test"], {
        cwd: root, stdio: "inherit", env: { ...process.env, CI: "1", E2E_WORKERS: "2", E2E_REUSE: "0", E2E_XBROWSER: browser === "firefox" ? "1" : "0",
          E2E_REPORTER: "dot,json", PLAYWRIGHT_JSON_OUTPUT_FILE: reportFile, E2E_TIMINGS_FILE: path.join(output, "timings.json") },
      });
      red ||= result.status !== 0;
      try {
        runs.push({ ...summarize(JSON.parse(readFileSync(reportFile, "utf8")), Math.round(performance.now() - started)), exit_code: result.status });
      } catch (error) {
        red = true;
        runs.push({ error: String(error), exit_code: result.status });
      }
      evidence.browsers[browser] = { runs };
      writeFileSync(path.join(output, "baseline.json"), `${JSON.stringify(evidence, null, 2)}\n`);
    }
    if (runs.every((run) => !run.error)) evidence.browsers[browser].summary = aggregate(runs);
  }
  writeFileSync(path.join(output, "baseline.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  process.exitCode = red ? 1 : 0;
}
