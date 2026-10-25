// Recorded E2E test durations and slot admission (docs/plans/test-strategy.md).
// e2e/timings-reporter.mjs records every passing test; scripts/e2e-slot.mjs plans shards from the record.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export const TIMINGS_FILE = process.env.E2E_TIMINGS_FILE ?? ".cache/console-e2e/timings.json";
const ALPHA = 0.5; // EWMA weight of the newest run
const MAX_AGE_MS = 30 * 86_400_000; // entries no run has refreshed in 30 days (deleted or renamed tests) drop out

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
