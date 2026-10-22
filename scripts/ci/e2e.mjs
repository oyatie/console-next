// SPDX-License-Identifier: LicenseRef-Proprietary
import { spawnSync } from "node:child_process";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { planBudget } from "./plan.mjs";
import { listedTests, plan, readTimings } from "../e2e-timings.mjs";

export function shards(tests, timings, config) {
  const jobs = plan(tests, timings, { target: config.e2eTargetSeconds, workers: config.e2eWorkers });
  if (!jobs.length) for (const project of new Set(tests.map((t) => t.project))) jobs.push({ project, files: [...new Set(tests.filter((t) => t.project === project).map((t) => t.file))] });
  const solo = "first-run-solo.spec.ts";
  const first = jobs.find((j) => j.files.includes(solo));
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
  if (["plan", "seed"].includes(process.argv[2])) {
    const recorded = { ...readTimings(config.e2eTimingsSeed), ...readTimings() };
    const seed = { _license: "SPDX-License-Identifier: LicenseRef-Proprietary" };
    mkdirSync(".cache/ci", { recursive: true });
    const include = ["chromium", "firefox"].flatMap((browser) => {
      const result = spawnSync("node_modules/.bin/playwright", ["test", "--list", "--reporter=json"], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, env: { ...process.env, E2E_XBROWSER: browser === "firefox" ? "1" : "0" } });
      if (result.status !== 0) throw new Error("Playwright inventory failed");
      const inventory = `.cache/ci/playwright-${browser}.json`;
      writeFileSync(inventory, result.stdout);
      if (spawnSync("python3", ["scripts/ci/test-results.py", "--inventory", "playwright", browser, inventory], { stdio: "inherit" }).status !== 0) throw new Error("stale browser baseline");
      const tests = listedTests(JSON.parse(result.stdout));
      for (const test of tests) if (recorded[test.key]) seed[test.key] = recorded[test.key];
      return shards(tests, recorded, config).map((job) => ({ ...job, browser, est: job.est ?? config.e2eTargetSeconds }));
    });
    if (process.argv[2] === "seed") writeFileSync(config.e2eTimingsSeed, JSON.stringify(seed, null, 2) + "\n");
    if (!include.length || include.length > config.e2eMaxShards) throw new Error("invalid E2E matrix size");
    const outputs = process.env.CI_PLAN ? JSON.parse(process.env.CI_PLAN) : { backend: "true", web: "true", e2e: "true", unit: "true", db: "true" };
    const budget = planBudget(Object.fromEntries(Object.entries(outputs).map(([k, v]) => [k, v === "true"])), config, include);
    appendFileSync(process.env.GITHUB_OUTPUT, `budget=${JSON.stringify(budget)}\n`);
    appendFileSync(process.env.GITHUB_OUTPUT, `matrix=${JSON.stringify({ include })}\n`);
  } else if (process.argv[2] === "run") {
    const job = JSON.parse(process.env.SHARD);
    mkdirSync(".cache/ci/e2e-results", { recursive: true });
    const log = openSync(".cache/ci/e2e-results/run.log", "w", 0o600);
    try {
      const result = spawnSync("node_modules/.bin/playwright", ["test", ...job.files.map((file) => `e2e/${file}`), "--project", job.project, "--no-deps"], { stdio: ["ignore", log, log], env: { ...process.env, E2E_XBROWSER: job.browser === "firefox" ? "1" : "0", E2E_WORKERS: String(config.e2eWorkers) } });
      process.stdout.write(`Playwright exited ${result.status ?? 1}; details require the upload privacy scan.\n`);
      if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `traces=${existsSync("test-results") && readdirSync("test-results", { recursive: true }).some((file) => String(file).endsWith(".zip"))}\n`);
      const proof = spawnSync("python3", ["scripts/ci/test-results.py", "playwright", job.browser, process.env.PLAYWRIGHT_JUNIT_OUTPUT_FILE ?? ".cache/ci/e2e-results/junit.xml", String(result.status ?? -1)], { stdio: "inherit" });
      process.exitCode = proof.status ?? 1;
    } finally { closeSync(log); }
  } else throw new Error("expected plan or run");
}
