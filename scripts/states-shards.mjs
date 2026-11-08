// SPDX-License-Identifier: LicenseRef-Proprietary
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listedTests, plan } from "./e2e-timings.mjs";

const refuse = (reason, detail) => { throw new Error(`${reason}: ${detail}`); };
const positive = n => Number.isFinite(n) && n > 0;
// Run-to-run runner speed varies by about a third, so a shard gets this much time over its measured plan.
export const RUN_HEADROOM = 1.6;
const specPath = file => /^(?:(?:mock|states)\/[^/]+\.spec\.ts|layout\/layout\.spec\.ts)$/.test(file);

function validateTimings(timings) {
  const { budgetSeconds, timeoutSeconds = budgetSeconds, runLimitSeconds = timeoutSeconds * RUN_HEADROOM, setupAllowanceSeconds, startupSeconds, workers, defaultTestSeconds, specs = {}, maxShards = 256 } = timings;
  if (![budgetSeconds, timeoutSeconds, runLimitSeconds, setupAllowanceSeconds, startupSeconds, workers, defaultTestSeconds].every(positive) || timeoutSeconds < budgetSeconds || runLimitSeconds < timeoutSeconds || !Number.isInteger(workers) || !Number.isInteger(maxShards) || maxShards < 1 || maxShards > 256 || startupSeconds >= Math.min(budgetSeconds, runLimitSeconds / RUN_HEADROOM) || !specs || typeof specs !== "object")
    refuse("STATES_INVALID_TIMINGS", "expected positive run/setup budgets, startup, workers, default and per-spec durations");
  for (const [file, entry] of Object.entries(specs)) if (!specPath(file) || !positive(entry?.seconds) || !Number.isInteger(entry?.tests) || entry.tests <= 0)
    refuse("STATES_INVALID_TIMINGS", file);
}

/** Only this repository's dev artifacts may supply timings; PRs cannot replace trusted measurements. */
export async function restoreDevTimings(settings, { apiUrl, repository, repositoryId, token }, request = fetch) {
  validateTimings(settings);
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" };
  const get = async url => {
    const response = await request(url, { headers, signal: AbortSignal.timeout(60_000) });
    if (!response.ok) refuse("STATES_TIMINGS_FETCH", `HTTP ${response.status}`);
    return response;
  };
  const artifacts = [];
  for (let page = 1; ; page++) {
    const response = await get(`${apiUrl}/repos/${repository}/actions/artifacts?name=states-timings&per_page=100&page=${page}`);
    const batch = (await response.json()).artifacts;
    if (!Array.isArray(batch)) refuse("STATES_TIMINGS_FETCH", "missing artifact list");
    artifacts.push(...batch);
    if (batch.length < 100) break;
  }
  const candidates = artifacts.filter(a => !a.expired && a.workflow_run?.head_branch === "dev" &&
    a.workflow_run.repository_id === repositoryId && a.workflow_run.head_repository_id === repositoryId)
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id);
  for (const artifact of candidates) {
    const response = await get(`${apiUrl}/repos/${repository}/actions/artifacts/${artifact.id}/zip`);
    // Read one JSON member without extracting archive paths; Python is already used by the CI evidence gates.
    const decoded = spawnSync("python3", ["-c", "import io,sys,zipfile; sys.stdout.buffer.write(zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())).read('timings.json'))"],
      { input: Buffer.from(await response.arrayBuffer()), maxBuffer: 16 * 1024 * 1024 });
    if (decoded.status !== 0) refuse("STATES_TIMINGS_FETCH", "cannot read timings archive");
    const measured = JSON.parse(decoded.stdout.toString());
    if (measured.workers !== settings.workers) continue;
    validateTimings({ ...settings, specs: measured.specs });
    if (!measured.specs || !Object.keys(measured.specs).length) refuse("STATES_INVALID_TIMINGS", "empty measurements");
    return { timings: { workers: measured.workers, specs: measured.specs }, runId: artifact.workflow_run.id };
  }
  refuse("STATES_MISSING_TIMINGS", "no unexpired dev measurements for the configured worker count");
}

/** Settings are committed; cached wall durations are reusable only at the same worker count. */
export function planStates(report, timings, measured) {
  validateTimings(timings);
  const specs = measured?.workers === timings.workers ? { ...(timings.specs ?? {}), ...measured.specs } : (timings.specs ?? {});
  validateTimings({ ...timings, specs });
  if (report.errors?.length) refuse("STATES_DISCOVERY_FAILED", JSON.stringify(report.errors));
  const counts = new Map();
  for (const { file } of listedTests(report)) {
    if (!specPath(file)) refuse("STATES_DISCOVERY_FAILED", `unexpected spec path ${file}`);
    counts.set(file, (counts.get(file) ?? 0) + 1);
  }
  if (!counts.size) refuse("STATES_EMPTY_SUITE", "no runnable state specs");
  const { startupSeconds, workers, defaultTestSeconds, maxShards = 256 } = timings;
  // Nearest-rank P95 protects new specs from the slow measured tail, with the configured default as a floor.
  const perTest = Object.values(specs).map(entry => entry.seconds * workers / entry.tests).sort((a, b) => a - b);
  const unknownTestSeconds = Math.max(defaultTestSeconds, perTest[Math.ceil(perTest.length * 0.95) - 1] ?? 0);
  const unmeasured = [...counts].filter(([file, tests]) => tests > (specs[file]?.tests ?? 0)).map(([file]) => file);
  // Keep RUN_HEADROOM under the run limit even when whole-file packing stretches the target.
  const executionSeconds = timings.timeoutSeconds ?? timings.budgetSeconds;
  const timeoutSeconds = Math.min(executionSeconds, Math.floor((timings.runLimitSeconds ?? executionSeconds * RUN_HEADROOM) / RUN_HEADROOM));
  const durations = Object.fromEntries([...counts].map(([file, tests]) => {
    const old = specs[file];
    return [file, { s: (old?.seconds ?? 0) * workers + Math.max(0, tests - (old?.tests ?? 0)) * unknownTestSeconds }];
  }));
  const seconds = Object.values(durations).map(({ s }) => s / workers);
  const minimum = Math.ceil(startupSeconds + seconds.reduce((sum, s) => sum + s, 0) / maxShards);
  let budgetSeconds = Math.min(timeoutSeconds, Math.max(timings.budgetSeconds, Math.ceil(startupSeconds + Math.max(...seconds))));
  let jobs;
  try {
    const attempts = Math.ceil(timeoutSeconds - budgetSeconds) + 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      jobs = plan([...counts.keys()].map(file => ({ project: "states", file, key: file })), durations,
        { target: budgetSeconds, boot: startupSeconds, workers, strict: true });
      if (jobs.length <= maxShards) break;
      if (budgetSeconds >= timeoutSeconds) refuse("STATES_TIMEOUT_LIMIT", `${maxShards} shards cannot fit within ${timeoutSeconds}s`);
      // Whole specs may need more than the average load to fit within the runner cap.
      budgetSeconds = Math.min(timeoutSeconds, Math.max(budgetSeconds + 1, minimum));
    }
    if (jobs.length > maxShards) refuse("STATES_TIMEOUT_LIMIT", `${attempts} planning attempts exhausted`);
  } catch (error) {
    const guidance = unmeasured.length ? `; CI measurements are not yet available for: ${unmeasured.join(", ")}` : "";
    throw new Error(error.message.replace(/^E2E_/, "STATES_") + guidance);
  }
  const runTimeoutMinutes = Math.ceil(budgetSeconds * RUN_HEADROOM / 60);
  const jobTimeoutMinutes = Math.ceil(timings.setupAllowanceSeconds / 60) + runTimeoutMinutes;
  return { budgetSeconds, runTimeoutMinutes, jobTimeoutMinutes, testCounts: Object.fromEntries(counts),
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
    if (command === "restore") {
      const restored = await restoreDevTimings(readJson(first), {
        apiUrl: process.env.GITHUB_API_URL, repository: process.env.GITHUB_REPOSITORY,
        repositoryId: Number(process.env.GITHUB_REPOSITORY_ID), token: process.env.GH_TOKEN,
      });
      writeJson(second, restored.timings);
      console.log(`Restored state timings from dev run ${restored.runId}`);
    } else if (command === "plan") {
      const timings = readJson(second);
      const plan = planStates(readJson(first), timings, rest[0] && existsSync(rest[0]) ? readJson(rest[0]) : undefined);
      writeJson(third, plan);
      if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `matrix=${JSON.stringify({ include: plan.shards.map(s => ({ shard: s.id, runTimeoutMinutes: plan.runTimeoutMinutes, jobTimeoutMinutes: plan.jobTimeoutMinutes })) })}\n`);
      console.log(plan.shards.map(s => `states ${s.id}: ~${Math.ceil(s.seconds)}s (${s.files.length} specs)`).join("\n"));
    } else if (command === "run") {
      const plan = readJson(first), id = Number(second);
      const files = filesForShard(plan, id);
      const list = `.cache/states-shard-${second}.txt`;
      mkdirSync(path.dirname(list), { recursive: true });
      writeFileSync(list, files.map(f => f.slice(4)).join("\n"));
      const output = process.env.PLAYWRIGHT_JSON_OUTPUT_FILE ?? path.resolve(`.cache/states-report-${id}.json`);
      const timings = readJson("e2e/mock/timings.json");
      validateTimings(timings);
      const result = spawnSync("npm", ["run", "e2e:states", "--", `--test-list=${list}`, `--global-timeout=${Math.ceil(plan.budgetSeconds * RUN_HEADROOM) * 1000}`], { stdio: "inherit", env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_FILE: output } });
      if (result.status === 0) refreshTimings(timings, { ...plan, shards: [{ ...plan.shards[id - 1], id: 1 }] }, [readJson(output)]);
      process.exitCode = result.status ?? 1;
    } else if (command === "refresh") {
      writeJson(third, refreshTimings(readJson(first), readJson(second), rest.map(readJson)));
    } else refuse("STATES_INVALID_COMMAND", "use restore <settings> <measurements>, plan <listing> <settings> <plan> [measurements], run <plan> <shard>, or refresh <settings> <plan> <output> <reports...>");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
