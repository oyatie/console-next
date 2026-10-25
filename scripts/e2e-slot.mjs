#!/usr/bin/env node
// `npm run e2e:agent -- <playwright args>`: runs on the first free E2E slot (e2e/slot.ts), each slot its own stack.
// A run whose recorded duration (scripts/e2e-timings.mjs) exceeds E2E_SHARD_TARGET_S (default 300 s) is split
// into jobs of at most that long, packed by duration and passed as explicit test lists; the jobs take free slots
// side by side, and their results merge into one report and one exit code. See docs/plans/test-strategy.md.
// E2E_SHARDS=k keeps the older count split (--shard=i/k plus one clock job); E2E_AUTOSHARD=0 runs one job.
// A job takes a slot only while the host's 1-minute load is at most E2E_MAX_LOAD_PER_CORE (default 2) per core.
// Slot 0's lock is the historical ~/.cache/console-e2e.lock, so runs from branches without slots still
// exclude slot 0 correctly.
// macOS uses BSD lockf; Linux (including the pinned Playwright container) uses util-linux flock.
// lockf is macOS/BSD only, as before; static shards, not work-stealing (Playwright has no dynamic sharding).
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { listedTests, plan } from "./e2e-plan.mjs";
import { admitted, maxLoadPerCore, readTimings } from "./e2e-timings.mjs";

// Share local history across worktrees, including every child reporter; CI supplies its own repository-local path.
process.env.E2E_TIMINGS_FILE ??= path.join(os.homedir(), ".cache/console-e2e/timings.json");

// A slot is a backend, a Vite and E2E_WORKERS browsers on the host (~3 cores, ~2 GiB) plus a compose stack in the
// colima-console-test VM (16 GiB, ~0.3 GiB per idle stack; six fit). The VM, not the host, is the real ceiling.
const CAP = Math.max(1, Math.min(Number(process.env.E2E_SLOT_CAP ?? 6), Math.floor(os.availableParallelism() / 3), Math.floor(os.freemem() / 2 ** 31)));
const SLOTS = Number(process.env.E2E_SLOTS ?? CAP);
// INTEG (an E2E_AGENT name containing "integ") must never starve behind implementation lanes: lanes use the lower
// slots and leave E2E_INTEG_RESERVE (default 2) free; INTEG tries the reserved slots first, then any other.
const INTEG = /integ/i.test(process.env.E2E_AGENT ?? "");
const RESERVE = Math.min(Number(process.env.E2E_INTEG_RESERVE ?? 2), SLOTS - 1);
const SLOT_ORDER = INTEG ? [...Array(SLOTS).keys()].reverse() : [...Array(SLOTS - RESERVE).keys()];
const SHARDS = Number(process.env.E2E_SHARDS ?? 1);
const TARGET_S = Number(process.env.E2E_SHARD_TARGET_S ?? 300);
const WORKERS = Number(process.env.E2E_WORKERS ?? (process.env.CI ? 2 : 4)); // as playwright.config.ts
const WAIT_MS = 30 * 60_000;
// Admission (scripts/e2e-timings.mjs admitted): no job takes a slot while the host's 1-minute load is above this per core.
let PER_CORE;
try {
  PER_CORE = maxLoadPerCore();
} catch (e) {
  console.error(`e2e:agent: ${e.message}`);
  process.exit(2);
}
const CORES = os.availableParallelism();
const BUSY = 75; // lockf -t 0: EX_TEMPFAIL when the lock is held
const lockFile = (slot) => path.join(os.homedir(), `.cache/console-e2e${slot === 0 ? "" : `-${slot}`}.lock`);
const lockCommand = process.platform === "darwin" ? "lockf" : "flock";
const lockPrefix = process.platform === "darwin" ? ["-k", "-t", "0"] : ["-n", "-E", String(BUSY)];
const RUN_DIR = path.resolve(`.cache/console-e2e-run-${process.pid}`);

const args = process.argv.slice(2);
// The caller's --reporter reaches the config as E2E_REPORTER, so the timings reporter (and a job's blob) stay on.
const rep = args.findIndex((a) => a === "--reporter" || a.startsWith("--reporter="));
if (rep >= 0) {
  const [flag] = args.splice(rep, 1);
  process.env.E2E_REPORTER = flag.includes("=") ? flag.slice(flag.indexOf("=") + 1) : args.splice(rep, 1)[0];
}

const runOn = (slot, job) =>
  new Promise((resolve) => {
    const child = spawn(lockCommand, [...lockPrefix, lockFile(slot), "node", "scripts/e2e-agent.mjs", ...args, ...job.extra], {
      stdio: job.prefix ? ["ignore", "pipe", "pipe"] : "inherit",
      env: { ...process.env, ...job.env, E2E_SLOT: String(slot) },
    });
    if (job.prefix)
      for (const [from, to] of [[child.stdout, process.stdout], [child.stderr, process.stderr]])
        createInterface({ input: from }).on("line", (line) => to.write(`[${job.label}] ${line}\n`));
    child.on("exit", (code) => resolve(code ?? 1));
  });

async function onFreeSlot(job) {
  job.env = { ...job.env, CONSOLE_E2E_QUEUED_AT: String(Date.now()) };
  const until = Date.now() + WAIT_MS;
  let busy = false;
  let loaded = false;
  for (;;) {
    const load = os.loadavg()[0];
    if (!admitted(load, CORES, PER_CORE)) {
      if (!loaded) console.log(`e2e:agent: ${job.label}: host load ${load.toFixed(1)} is above ${PER_CORE} per core (${PER_CORE * CORES} on ${CORES}), waiting (E2E_MAX_LOAD_PER_CORE)`);
      loaded = true;
    } else {
      for (const slot of SLOT_ORDER) {
        const started = Date.now();
        const code = await runOn(slot, { ...job, env: { ...job.env, E2E_ADMITTED_LOAD: load.toFixed(1) } });
        if (code !== BUSY) {
          console.log(`e2e:agent: ${job.label} ran on slot ${slot} in ${Math.round((Date.now() - started) / 1000)} s, exit ${code}, admitted at load ${load.toFixed(1)}`);
          return code;
        }
      }
      if (!busy) console.log(`e2e:agent: ${job.label}: all ${SLOTS} slots busy, waiting`);
      busy = true;
    }
    if (Date.now() > until) {
      console.error(`e2e:agent: ${job.label}: no free slot${loaded ? ` or host load at most ${PER_CORE * CORES}` : ""} within ${WAIT_MS / 60_000} min`);
      return 1;
    }
    await new Promise((r) => setTimeout(r, 5_000));
  }
}

// The tests this run selects, split by recorded duration; [] when one job fits in TARGET_S or listing fails.
function autoShards() {
  const listed = spawnSync("npx", ["playwright", "test", "--list", "--reporter=json", ...args], { encoding: "utf8", maxBuffer: 1 << 28 });
  try {
    return plan(listedTests(JSON.parse(listed.stdout), process.env.E2E_SERVED === "1"), readTimings(process.env.E2E_TIMINGS_FILE), { target: TARGET_S, workers: WORKERS });
  } catch {
    console.error("e2e:agent: could not list the tests; running unsharded");
    return [];
  }
}

// Sharding by count splits the "parallel" project only: Playwright runs a dependency project whole in every
// shard, and "clock" depends on "parallel" just to run alone on its backend. So the shards take
// --project=parallel and the @clock tests run as one more job on whichever slot is free (its own backend).
// A duration plan gives every job one project and --no-deps for the same reason.
const explicit = args.some((a) => /^--(project|shard|last-failed|list|ui|debug)\b/.test(a));
let jobs;
if (SHARDS > 1)
  jobs = [
    ...Array.from({ length: SHARDS }, (_, i) => ({ label: `shard ${i + 1}/${SHARDS}`, extra: ["--project=parallel", `--shard=${i + 1}/${SHARDS}`] })),
    { label: "clock", extra: ["--project=clock", "--no-deps", "--pass-with-no-tests"] },
  ];
else {
  const shards = process.env.E2E_AUTOSHARD === "0" || explicit ? [] : autoShards();
  if (shards.length) mkdirSync(RUN_DIR, { recursive: true });
  jobs = shards.map((s, i) => {
    const list = path.join(RUN_DIR, `job-${i + 1}.txt`);
    writeFileSync(list, s.files.join("\n"));
    console.log(`e2e:agent: job ${i + 1}/${shards.length} [${s.project}] ~${s.est} s: ${s.files.join(" ")}`);
    return { label: `${s.project} ${i + 1}/${shards.length}`, extra: [`--project=${s.project}`, "--no-deps", `--test-list=${list}`] };
  });
  if (!jobs.length) jobs = [{ label: "run", extra: [] }];
}

const started = Date.now();
if (jobs.length > 1) {
  mkdirSync(RUN_DIR, { recursive: true });
  jobs.forEach((job, i) => Object.assign(job, { prefix: true, env: { PLAYWRIGHT_BLOB_OUTPUT_FILE: path.join(RUN_DIR, `blob-${i + 1}.zip`) } }));
  // The served backend serves apps/web/dist: build it once, not once per job into the same directory.
  if (process.env.E2E_SERVED === "1") {
    if (spawnSync("npm", ["run", "build"], { stdio: "inherit" }).status !== 0) process.exit(1);
    process.env.E2E_PREBUILT = "1";
  }
}
const codes = await Promise.all(jobs.map(onFreeSlot));
if (jobs.length > 1) {
  console.log(`\ne2e:agent: ${jobs.length} jobs on up to ${Math.min(jobs.length, SLOTS)} slots, wall ${Math.round((Date.now() - started) / 1000)} s; merged report:`);
  spawnSync("npx", ["playwright", "merge-reports", "--reporter=dot", RUN_DIR], { stdio: "inherit" });
}
rmSync(RUN_DIR, { recursive: true, force: true });
process.exit(Math.max(...codes));
