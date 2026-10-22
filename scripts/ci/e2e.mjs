// SPDX-License-Identifier: LicenseRef-Proprietary
import { spawnSync } from "node:child_process";
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { listedTests, plan, readTimings } from "../e2e-timings.mjs";

export function shards(tests, timings, config) {
  const jobs = plan(tests, timings, { target: config.e2eTargetSeconds, workers: config.e2eWorkers });
  if (!jobs.length) for (const project of new Set(tests.map((t) => t.project))) jobs.push({ project, files: [...new Set(tests.filter((t) => t.project === project).map((t) => t.file))] });
  const solo = "first-run-solo.spec.ts";
  const first = jobs.find((j) => tests.some((t) => t.project === j.project && t.file === solo));
  if (first) {
    for (const job of jobs) job.files = job.files.filter((file) => file !== solo);
    first.files.unshift(solo);
    jobs.splice(jobs.indexOf(first), 1);
    jobs.unshift(first);
  }
  return jobs.filter((j) => j.files.length).map((job, i) => ({ ...job, shard: i + 1 }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = JSON.parse(readFileSync("scripts/ci/config.json", "utf8"));
  if (process.argv[2] === "plan") {
    const include = ["chromium", "firefox"].flatMap((browser) => {
      const result = spawnSync("node_modules/.bin/playwright", ["test", "--list", "--reporter=json"], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, env: { ...process.env, E2E_XBROWSER: browser === "firefox" ? "1" : "0" } });
      if (result.status !== 0) throw new Error("Playwright inventory failed");
      return shards(listedTests(JSON.parse(result.stdout)), readTimings(), config).map((job) => ({ ...job, browser }));
    });
    if (!include.length || include.length > 256) throw new Error("invalid E2E matrix size");
    appendFileSync(process.env.GITHUB_OUTPUT, `matrix=${JSON.stringify({ include })}\n`);
  } else if (process.argv[2] === "run") {
    const job = JSON.parse(process.env.SHARD);
    mkdirSync(".cache/ci/e2e-results", { recursive: true });
    const log = openSync(".cache/ci/e2e-results/run.log", "w", 0o600);
    try {
      const result = spawnSync("node_modules/.bin/playwright", ["test", ...job.files.map((file) => `e2e/${file}`), "--project", job.project, "--no-deps"], { stdio: ["ignore", log, log], env: { ...process.env, E2E_XBROWSER: job.browser === "firefox" ? "1" : "0", E2E_WORKERS: String(config.e2eWorkers) } });
      process.stdout.write(`Playwright exited ${result.status ?? 1}; details require the upload privacy scan.\n`);
      process.exitCode = result.status ?? 1;
    } finally { closeSync(log); }
  } else throw new Error("expected plan or run");
}
