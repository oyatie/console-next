// SPDX-License-Identifier: LicenseRef-Proprietary
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

function listeners(port) {
  const result = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"], { encoding: "utf8" });
  if (result.error || (result.status !== 0 && !(result.status === 1 && !result.stdout && !result.stderr)))
    throw new Error(`cannot inspect backend port ${port}: ${result.error?.message ?? result.stderr}`);
  return [...new Set(result.stdout.split("\n").filter((line) => /^p\d+$/.test(line)).map((line) => Number(line.slice(1))))];
}

function owner(pid) {
  const result = spawnSync("ps", ["-p", String(pid), "-o", "ppid=", "-o", "comm="], { encoding: "utf8" });
  if (result.status === 1 && !result.stdout && !result.stderr) return null;
  if (result.error || result.status !== 0) throw new Error(`cannot inspect pid ${pid}: ${result.error?.message ?? result.stderr}`);
  const match = result.stdout.trim().match(/^(\d+)\s+(.+)$/);
  if (!match) throw new Error(`cannot read parent and command for pid ${pid}`);
  return { parent: Number(match[1]), command: match[2] };
}

function orphan(port, pid) {
  const info = owner(pid);
  if (info && (info.parent !== 1 || path.basename(info.command) !== "console-app"))
    throw new Error(`backend port ${port} is held by pid ${pid} (parent ${info.parent}, command ${info.command}); refusing to stop anything except a console-app orphan with parent 1`);
  return info;
}

function signal(pid, name) {
  try { process.kill(pid, name); }
  catch (error) { if (error.code !== "ESRCH") throw error; }
}

/** Inspect every listener before stopping only positively identified console-app orphans. */
export async function reapOrphanListener(port) {
  const pids = listeners(port);
  for (const pid of pids) orphan(port, pid);
  for (const pid of pids) {
    if (!orphan(port, pid)) continue;
    signal(pid, "SIGTERM");
    const until = Date.now() + 5_000;
    while (listeners(port).includes(pid)) {
      if (Date.now() >= until) {
        if (orphan(port, pid)) signal(pid, "SIGKILL");
        break;
      }
      await delay(50);
    }
  }
  const until = Date.now() + 5_000;
  for (;;) {
    const remaining = listeners(port);
    if (!remaining.length) return;
    for (const pid of remaining) orphan(port, pid);
    if (Date.now() >= until) throw new Error(`backend port ${port} is still held by pid ${remaining.join(", ")} after orphan cleanup`);
    await delay(50);
  }
}

const groups = new Set();
process.on("exit", () => { for (const pid of groups) signal(-pid, "SIGKILL"); });
process.on("SIGINT", () => process.exit(130));
process.on("SIGTERM", () => process.exit(143));

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
