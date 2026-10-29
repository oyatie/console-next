// Recorded E2E test durations, the duration-based shard plan and slot admission (docs/plans/test-strategy.md).
// e2e/timings-reporter.mjs records every passing test; scripts/e2e-slot.mjs plans shards from the record.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Shared by every worktree (next to the slot locks), so a fresh worktree plans from the last runs anywhere.
export const TIMINGS_FILE = process.env.E2E_TIMINGS_FILE ?? path.join(os.homedir(), ".cache/console-e2e/timings.json");
const ALPHA = 0.5; // EWMA weight of the newest run
const MAX_AGE_MS = 30 * 86_400_000; // entries no run has refreshed in 30 days (deleted or renamed tests) drop out
const FALLBACK_S = 10; // per test, when nothing is recorded yet

/** Served runs have the same project names as Chromium dev runs but a different speed; Firefox's project is its own. */
export const projectKey = (name) => (process.env.E2E_SERVED === "1" ? `served:${name}` : name);
/** `file` is relative to the test dir (e2e/), `titles` the describe titles and the test title. */
export const testKey = (project, file, titles) => [projectKey(project), file, ...titles].join(" › ");

export function readTimings(file = TIMINGS_FILE) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

/** Folds one run's `{key: seconds}` into the record. */
// read-merge-rename without a lock; two shards ending in the same few ms can drop one's update, which the next run repairs.
export function record(observed, { file = TIMINGS_FILE, now = Date.now() } = {}) {
  const timings = readTimings(file);
  for (const [key, s] of Object.entries(observed)) {
    const old = timings[key]?.s;
    timings[key] = { s: Math.round((old === undefined ? s : old * (1 - ALPHA) + s * ALPHA) * 10) / 10, at: now };
  }
  for (const [key, { at }] of Object.entries(timings)) if (now - at > MAX_AGE_MS) delete timings[key];
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(timings, null, 1));
  renameSync(tmp, file);
}

/** The tests a `playwright test --list --reporter=json` run would execute, as `{project, file, key}`. */
export function listedTests(report) {
  const tests = [];
  const walk = (suite, file, titles) => {
    for (const spec of suite.specs ?? [])
      for (const t of spec.tests)
        if (t.expectedStatus !== "skipped") tests.push({ project: t.projectName, file, key: testKey(t.projectName, file, [...titles, spec.title]) });
    for (const child of suite.suites ?? []) walk(child, file, [...titles, child.title]);
  };
  for (const fileSuite of report.suites) walk(fileSuite, fileSuite.file, []);
  return tests;
}

/**
 * Splits the listed tests into jobs of at most `target` seconds each: per project, ceil(estimate / budget) shards,
 * whole files packed longest-first into the lightest shard. A job's estimate is `boot` plus its seconds over the
 * project's workers ("clock" runs one at a time). Returns [] when the whole run fits in one job.
 * `strict` always emits jobs, refuses oversized files and adds bins until every job fits the target.
 */
export function plan(tests, timings, { target = 300, workers = 4, boot = 40, strict = false } = {}) {
  const known = tests.map((t) => timings[t.key]?.s).filter((s) => s !== undefined).sort((a, b) => a - b);
  const median = known.length ? known[known.length >> 1] : FALLBACK_S;
  const projects = new Map();
  for (const t of tests) {
    const files = projects.get(t.project) ?? projects.set(t.project, new Map()).get(t.project);
    files.set(t.file, (files.get(t.file) ?? 0) + (timings[t.key]?.s ?? median));
  }
  const width = (project) => (project === "clock" ? 1 : workers);
  const sum = (files) => [...files.values()].reduce((a, b) => a + b, 0);
  const whole = boot + [...projects].reduce((acc, [p, files]) => acc + sum(files) / width(p), 0);
  if (whole <= target && !strict) return [];
  const budget = strict ? target - boot : Math.max(target - boot, 30);
  return [...projects].flatMap(([project, files]) => {
    const sorted = [...files].sort((a, b) => b[1] - a[1] || (strict ? a[0].localeCompare(b[0]) : 0));
    if (strict) for (const [file, seconds] of sorted) {
      if (boot + seconds / width(project) > target)
        throw new Error(`E2E_SPEC_OVER_BUDGET: ${file}: ${boot + seconds / width(project)}s exceeds ${target}s; split this spec`);
    }
    for (let count = Math.ceil(sum(files) / width(project) / budget); ; count++) {
      const bins = Array.from({ length: count }, () => ({ project, files: [], s: 0 }));
      for (const [file, s] of sorted) {
        const bin = bins.reduce((a, b) => (b.s < a.s ? b : a));
        bin.files.push(file);
        bin.s += s;
      }
      if (!strict || bins.every(b => boot + b.s / width(project) <= target))
        return bins.filter((b) => b.files.length).map((b) => ({ project, files: b.files, est: strict ? boot + b.s / width(project) : Math.round(boot + b.s / width(project)) }));
    }
  });
}

/**
 * The host load a job may start under, per core (E2E_MAX_LOAD_PER_CORE, default 2: 36 on 18 cores). Above it a red is
 * load noise, not a reproducible result (registerEntity's 5 s heading wait failed 7–9 of 10 runs at load 25–80), so
 * the job waits for the load to fall as it waits for a busy slot. 0 turns admission off (a deliberate stress run).
 */
export function maxLoadPerCore(value = process.env.E2E_MAX_LOAD_PER_CORE) {
  const n = Number(value ?? 2);
  if (!Number.isFinite(n) || n < 0 || value === "") throw new Error(`E2E_MAX_LOAD_PER_CORE must be a number >= 0 (got ${JSON.stringify(value)})`);
  return n;
}

/** Whether a job may take a slot now: the host's 1-minute load is at most `perCore` × `cores` (always when 0). */
export const admitted = (load, cores, perCore) => perCore === 0 || load <= perCore * cores;
