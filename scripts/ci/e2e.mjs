// SPDX-License-Identifier: LicenseRef-Proprietary
import { spawnSync } from "node:child_process";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";
import { planBudget } from "./plan.mjs";
import { listedTests, plan, readTimings } from "../e2e-timings.mjs";

export function shards(tests, timings, config, maxSeconds = Infinity) {
  const target = Math.min(config.e2eTargetSeconds, maxSeconds);
  const jobs = plan(tests, timings, { target, workers: config.e2eWorkers, maxSeconds });
  if (!jobs.length) for (const project of new Set(tests.map((t) => t.project))) jobs.push({ project, files: [...new Set(tests.filter((t) => t.project === project).map((t) => t.file))], est: target });
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
  if (["plan", "seed", "check-seed"].includes(process.argv[2])) {
    const checking = process.argv[2] === "check-seed";
    const selection = process.argv[2] === "plan" && process.env.CI_PLAN ? JSON.parse(process.env.CI_PLAN) : {};
    const recorded = { ...readTimings(config.e2eTimingsSeed), ...(checking ? {} : readTimings()) };
    const seed = { _license: "SPDX-License-Identifier: LicenseRef-Proprietary" };
    mkdirSync(".cache/ci", { recursive: true });
    const inventories = (selection.browsers ? JSON.parse(selection.browsers) : config.releaseBrowsers).map((browser) => {
      const result = spawnSync("node_modules/.bin/playwright", ["test", "--list", "--reporter=json"], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, env: { ...process.env, E2E_XBROWSER: browser === "firefox" ? "1" : "0" } });
      if (result.status !== 0) throw new Error("Playwright inventory failed");
      const inventory = `.cache/ci/playwright-${browser}.json`;
      writeFileSync(inventory, result.stdout);
      if (spawnSync("python3", ["scripts/ci/test-results.py", "--inventory", "playwright", browser, inventory], { stdio: "inherit" }).status !== 0) throw new Error("stale browser baseline");
      const files = selection.e2eFiles ? JSON.parse(selection.e2eFiles) : null;
      const tests = listedTests(JSON.parse(result.stdout)).filter((test) => files === null || files.includes(test.file));
      for (const test of tests) if (recorded[test.key]) seed[test.key] = recorded[test.key];
      return { browser, tests };
    });
    if (!inventories.some(({ tests }) => tests.length)) throw new Error("empty E2E inventory");
    const generated = JSON.stringify(seed, null, 2) + "\n";
    if (checking) {
      if (readFileSync(config.e2eTimingsSeed, "utf8") !== generated) throw new Error("stale browser timing seed; regenerate with E2E_SERVED=1 GITHUB_OUTPUT=/tmp/ci-plan node scripts/ci/e2e.mjs seed");
      process.exit(0);
    }
    if (process.argv[2] === "seed") writeFileSync(config.e2eTimingsSeed, generated);
    const outputs = process.env.CI_PLAN ? JSON.parse(process.env.CI_PLAN) : { backend: "true", web: "true", e2e: "true", unit: "true", db: "true" };
    const selected = Object.fromEntries(Object.entries(outputs).map(([k, v]) => [k, v === "true"]));
    const workflow = load(readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8")).jobs;
    const maxSeconds = Math.ceil((workflow.e2e["timeout-minutes"] * 0.8 - config.jobMinutes.e2eSetup) * 60) - 1;
    const preferred = Math.min(config.e2eReservedShards, config.maxJobs - planBudget(selected, config, []).jobs);
    let target = Math.min(config.e2eTargetSeconds, maxSeconds), include;
    do {
      include = inventories.flatMap(({ browser, tests }) => shards(tests, recorded, { ...config, e2eTargetSeconds: target }, maxSeconds).map((job) => ({ ...job, browser })));
      if (include.length <= preferred || target === maxSeconds) break;
      target = Math.min(target * 1.1, maxSeconds);
    } while (true);
    const budget = planBudget(selected, config, include);
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
  } else throw new Error("expected plan, seed, check-seed or run");
}
