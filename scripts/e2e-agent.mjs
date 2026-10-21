#!/usr/bin/env node
// One E2E run on one slot. scripts/e2e-slot.mjs (`npm run e2e:agent -- <playwright args>`) runs it under
// `lockf -k` on the slot's lock file, so a slot's ports and compose project (e2e/slot.ts) have one run at a
// time; the lock file keeps a record of its last holder.
// The parent slot runner uses lockf on macOS and flock in Linux containers.
// lockf is macOS/BSD only; CI and humans use `npm run e2e`.
import { proofTiming } from "./proof-timing.mjs";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const acquired = Date.now();
const SLOT = Number(process.env.E2E_SLOT ?? 0);
const LOCK = path.join(os.homedir(), `.cache/console-e2e${SLOT === 0 ? "" : `-${SLOT}`}.lock`);
const { E2E_AGENT: agent, CONSOLE_REPO: repo, CONSOLE_APP_BIN: bin, E2E_REUSE } = process.env;
const fail = (why) => {
  console.error(`e2e:agent: ${why}`);
  process.exit(2);
};

if (!agent) fail("set E2E_AGENT to a name unique to you (it guards E2E_REUSE)");
for (const [name, value] of [["CONSOLE_REPO", repo], ["CONSOLE_APP_BIN", bin]])
  if (!value || !path.isAbsolute(value) || !existsSync(value)) fail(`${name} must be an absolute path that exists (got ${value || "nothing"})`);

const holder = { agent, repo, bin, web: process.cwd() };
let last = {};
try {
  last = JSON.parse(readFileSync(LOCK, "utf8"));
} catch {}
// Reuse keeps the last run's database: only its own holder knows what is in it.
if (E2E_REUSE === "1" && Object.keys(holder).some((k) => last[k] !== holder[k]))
  fail(`E2E_REUSE=1 needs the same agent, repos and binary as the last run (${JSON.stringify(last)}); run without it`);
// `load`: the host's 1-minute load this run was admitted at (scripts/e2e-slot.mjs), so a red can be read against it.
writeFileSync(LOCK, JSON.stringify({ ...holder, pid: process.pid, started: new Date().toISOString(), load: Number(process.env.E2E_ADMITTED_LOAD ?? os.loadavg()[0].toFixed(1)) }));

const run = spawnSync("npx", ["playwright", "test", ...process.argv.slice(2)], { stdio: "inherit" });
proofTiming("e2e", Number(process.env.CONSOLE_E2E_QUEUED_AT ?? acquired), acquired, run.status ?? 1);
process.exit(run.status ?? 1);
