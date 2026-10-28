// SPDX-License-Identifier: LicenseRef-Proprietary
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// -w: Linux lsof prints mount warnings on stderr even for a free port; they are not errors.
function listeners(port) {
  const result = spawnSync("lsof", ["-w", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"], { encoding: "utf8" });
  if (result.error || (result.status !== 0 && !(result.status === 1 && !result.stdout && !result.stderr)))
    throw new Error(`cannot inspect backend port ${port}: ${result.error?.message ?? result.stderr}`);
  return [...new Set(result.stdout.split("\n").filter((line) => /^p\d+$/.test(line)).map((line) => Number(line.slice(1))))];
}

function owner(pid) {
  const result = spawnSync("ps", ["-p", String(pid), "-o", "ppid=", "-o", "stat=", "-o", "comm="], { encoding: "utf8" });
  if (result.status === 1 && !result.stdout && !result.stderr) return null;
  if (result.error || result.status !== 0) throw new Error(`cannot inspect pid ${pid}: ${result.error?.message ?? result.stderr}`);
  const match = result.stdout.trim().match(/^(\d+)\s+(\S+)\s+(.+)$/);
  if (!match) throw new Error(`cannot read parent and command for pid ${pid}`);
  if (match[2].startsWith("Z")) return null;
  return { parent: Number(match[1]), command: match[3] };
}

function orphan(port, pid, record) {
  const info = owner(pid);
  // Linux may adopt dead launchers' children into a live subreaper instead of pid 1.
  if (info && !(path.basename(info.command) === "console-app" && record?.apiPid === pid &&
      Number.isSafeInteger(record.pid) && record.pid > 1 && !owner(record.pid))) {
    const manual = info.parent === 1 && path.basename(info.command) === "console-app" && record && !Object.hasOwn(record, "apiPid")
      ? `; legacy slot record has no apiPid; verify this orphan, then run \`kill -TERM ${pid}\` and retry`
      : "";
    throw new Error(`backend port ${port} is held by pid ${pid} (parent ${info.parent}, command ${info.command}); refusing to stop anything except this slot's recorded console-app with an exited launcher${manual}`);
  }
  return info;
}

function signal(pid, name) {
  try { process.kill(pid, name); }
  catch (error) {
    // macOS returns EPERM for a group whose exited leader and descendants are zombies.
    if (error.code !== "ESRCH" && !(error.code === "EPERM" && pid < 0 && !owner(-pid))) throw error;
  }
}

/** Inspect every listener before stopping only positively identified console-app orphans. */
export async function reapOrphanListener(port, file) {
  const pids = listeners(port);
  if (!pids.length) return;
  let record;
  try { record = JSON.parse(readFileSync(file, "utf8")); }
  catch (error) {
    throw new Error(`backend port ${port} is held by pid ${pids.join(", ")}; refusing to stop without a readable launcher record at ${file}`, { cause: error });
  }
  for (const pid of pids) orphan(port, pid, record);
  for (const pid of pids) {
    if (!orphan(port, pid, record)) continue;
    signal(pid, "SIGTERM");
    const until = Date.now() + 5_000;
    while (listeners(port).includes(pid)) {
      if (Date.now() >= until) {
        if (orphan(port, pid, record)) signal(pid, "SIGKILL");
        break;
      }
      await delay(50);
    }
  }
  const until = Date.now() + 5_000;
  for (;;) {
    const remaining = listeners(port);
    if (!remaining.length) return;
    for (const pid of remaining) orphan(port, pid, record);
    if (Date.now() >= until) throw new Error(`backend port ${port} is still held by pid ${remaining.join(", ")} after orphan cleanup`);
    await delay(50);
  }
}

const groups = new Set();

/** The launcher owns process-wide cleanup; importing helpers must not change a test worker. */
export function installBackendCleanup() {
  process.on("exit", () => { for (const pid of groups) signal(-pid, "SIGKILL"); });
  process.on("SIGINT", () => process.exit(130));
  process.on("SIGTERM", () => process.exit(143));
}

export function stopBackend(child, name = "SIGTERM") {
  if (child.pid) signal(-child.pid, name);
}

/** A detached child leads its own group; synchronous exit cleanup also stops its descendants. */
export function startBackend(bin, options) {
  const child = spawn(bin, [], { ...options, detached: true });
  if (child.pid) groups.add(child.pid);
  child.once("exit", () => {
    stopBackend(child, "SIGKILL");
    groups.delete(child.pid);
  });
  return child;
}

export async function backendReady(port) {
  for (;;) {
    const ready = await new Promise((resolve) => {
      const req = http.get(`http://127.0.0.1:${port}/readyz`, (response) => {
        response.resume();
        resolve(response.statusCode === 200);
      });
      req.on("error", () => resolve(false));
      req.setTimeout(1_000, () => req.destroy());
    });
    if (ready) return;
    await delay(100);
  }
}
