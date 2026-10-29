// SPDX-License-Identifier: LicenseRef-Proprietary
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listedTests, plan } from "./e2e-timings.mjs";

const refuse = (reason, detail) => { throw new Error(`${reason}: ${detail}`); };
const positive = n => Number.isFinite(n) && n > 0;
const specPath = file => /^(?:(?:mock|states)\/[^/]+\.spec\.ts|layout\/layout\.spec\.ts)$/.test(file);

function validateTimings(timings) {
  const { budgetSeconds, startupSeconds, workers, defaultTestSeconds, specs } = timings;
  if (![budgetSeconds, startupSeconds, workers, defaultTestSeconds].every(positive) || !Number.isInteger(workers) || startupSeconds >= budgetSeconds || !specs || typeof specs !== "object")
    refuse("STATES_INVALID_TIMINGS", "expected positive budget, startup, workers, default and per-spec durations");
  for (const [file, entry] of Object.entries(specs)) if (!specPath(file) || !positive(entry?.seconds) || !Number.isInteger(entry?.tests) || entry.tests <= 0)
    refuse("STATES_INVALID_TIMINGS", file);
}

/** Settings are committed; cached wall durations are reusable only at the same worker count. */
export function planStates(report, timings, measured) {
  validateTimings(timings);
  const specs = measured?.workers === timings.workers ? { ...timings.specs, ...measured.specs } : timings.specs;
  validateTimings({ ...timings, specs });
  if (report.errors?.length) refuse("STATES_DISCOVERY_FAILED", JSON.stringify(report.errors));
  const counts = new Map();
  for (const { file } of listedTests(report)) {
    if (!specPath(file)) refuse("STATES_DISCOVERY_FAILED", `unexpected spec path ${file}`);
    counts.set(file, (counts.get(file) ?? 0) + 1);
  }
  if (!counts.size) refuse("STATES_EMPTY_SUITE", "no runnable state specs");
  const { budgetSeconds, startupSeconds, workers, defaultTestSeconds } = timings;
  const durations = Object.fromEntries([...counts].map(([file, tests]) => {
    const old = specs[file];
    return [file, { s: (old?.seconds ?? 0) * workers + Math.max(0, tests - (old?.tests ?? 0)) * defaultTestSeconds }];
  }));
  let jobs;
  try {
    jobs = plan([...counts.keys()].map(file => ({ project: "states", file, key: file })), durations,
      { target: budgetSeconds, boot: startupSeconds, workers, strict: true });
  } catch (error) {
    throw new Error(error.message.replace(/^E2E_/, "STATES_"));
  }
  if (jobs.length > 256) refuse("STATES_MATRIX_LIMIT", "plan exceeds GitHub's 256-job matrix limit");
  return { budgetSeconds, testCounts: Object.fromEntries(counts),
    shards: jobs.map((job, i) => ({ id: i + 1, files: job.files.map(file => `e2e/${file}`), seconds: job.est })) };
}

export function filesForShard(plan, id) {
  const files = new Set();
  if (!positive(plan.budgetSeconds) || !Array.isArray(plan.shards) || !plan.shards.length || plan.shards.length > 256)
    refuse("STATES_INVALID_PLAN", "invalid shard collection");
  for (const [index, shard] of plan.shards.entries()) {
    if (shard.id !== index + 1 || !positive(shard.seconds) || shard.seconds > plan.budgetSeconds || !Array.isArray(shard.files) || !shard.files.length)
      refuse("STATES_INVALID_PLAN", `invalid or over-budget shard ${index + 1}`);
    for (const file of shard.files) {
      if (typeof file !== "string" || !file.startsWith("e2e/") || !specPath(file.slice(4)) || files.has(file)) refuse("STATES_INVALID_PLAN", `invalid or repeated spec ${file}`);
      files.add(file);
    }
  }
  if (!Number.isInteger(id) || id < 1 || id > plan.shards.length) refuse("STATES_INVALID_SHARD", `${id}; planned 1..${plan.shards.length}`);
  return plan.shards[id - 1].files;
}

/** Replace the snapshot only with complete, successful results from every planned spec. */
export function refreshTimings(timings, plan, reports) {
  validateTimings(timings);
  const expected = new Set(plan.shards.flatMap(s => filesForShard(plan, s.id)).map(f => f.slice(4)));
  const specs = {};
  for (const report of reports) {
    if (report.errors?.length || report.config?.workers !== undefined && report.config.workers !== timings.workers) refuse("STATES_INCOMPLETE_RESULTS", "report errors or worker count mismatch");
    for (const file of report.suites) {
      let seconds = 0, tests = 0;
      const walk = suite => {
        for (const spec of suite.specs ?? []) for (const test of spec.tests) {
          if (test.expectedStatus === "skipped") continue;
          if (test.results.length !== 1 || test.results[0].status !== "passed" || !Number.isFinite(test.results[0].duration) || test.results[0].duration < 0)
            refuse("STATES_INCOMPLETE_RESULTS", file.file);
          seconds += test.results[0].duration / 1000 / timings.workers;
          tests++;
        }
        for (const child of suite.suites ?? []) walk(child);
      };
      walk(file);
      if (!tests) continue;
      if (!expected.has(file.file) || Object.hasOwn(specs, file.file) || tests !== plan.testCounts[file.file]) refuse("STATES_INCOMPLETE_RESULTS", file.file);
      specs[file.file] = { seconds: Math.max(0.1, Math.ceil(seconds * 10) / 10), tests };
    }
  }
  if (Object.keys(specs).length !== expected.size) refuse("STATES_INCOMPLETE_RESULTS", "missing planned specs");
  return { workers: timings.workers, specs: Object.fromEntries(Object.entries(specs).sort(([a], [b]) => a.localeCompare(b))) };
}

const readJson = file => JSON.parse(readFileSync(file, "utf8"));
function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, first, second, third, ...rest] = process.argv.slice(2);
    if (command === "plan") {
      const timings = readJson(second);
      const plan = planStates(readJson(first), timings, rest[0] && existsSync(rest[0]) ? readJson(rest[0]) : undefined);
      writeJson(third, plan);
      if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `matrix=${JSON.stringify({ shard: plan.shards.map(s => s.id) })}\n`);
      console.log(plan.shards.map(s => `states ${s.id}: ~${Math.ceil(s.seconds)}s (${s.files.length} specs)`).join("\n"));
    } else if (command === "run") {
      const plan = readJson(first), id = Number(second);
      const files = filesForShard(plan, id);
      const list = `.cache/states-shard-${second}.txt`;
      mkdirSync(path.dirname(list), { recursive: true });
      writeFileSync(list, files.map(f => f.slice(4)).join("\n"));
      const output = process.env.PLAYWRIGHT_JSON_OUTPUT_FILE ?? path.resolve(`.cache/states-report-${id}.json`);
      const result = spawnSync("npm", ["run", "e2e:states", "--", `--test-list=${list}`], { stdio: "inherit", env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_FILE: output } });
      if (result.status === 0) refreshTimings(readJson("e2e/mock/timings.json"), { ...plan, shards: [{ ...plan.shards[id - 1], id: 1 }] }, [readJson(output)]);
      process.exitCode = result.status ?? 1;
    } else if (command === "refresh") {
      writeJson(third, refreshTimings(readJson(first), readJson(second), rest.map(readJson)));
    } else refuse("STATES_INVALID_COMMAND", "use plan <listing> <settings> <plan> [measurements], run <plan> <shard>, or refresh <settings> <plan> <output> <reports...>");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
