// SPDX-License-Identifier: LicenseRef-Proprietary
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, statfsSync } from "node:fs";
import path from "node:path";

const [label, ...command] = process.argv.slice(2);
if (!/^[a-zA-Z0-9-]+$/.test(label ?? "")) throw new Error("RUNNER_DISK_CONFIG: provide a checkpoint name");
const directory = path.join(process.env.GITHUB_WORKSPACE || process.cwd(), ".cache/runner-disk");
mkdirSync(directory, { recursive: true });
const log = path.join(directory, `${label}.log`);
const record = text => { appendFileSync(log, text); process.stdout.write(text); };
const minimum = Number(process.env.RUNNER_DISK_MIN_BYTES);
let child, timer, killTimer, refused = false;
const terminate = () => {
  if (!child?.pid) return;
  const signal = name => {
    try { process.kill(-child.pid, name); } catch (error) { if (error.code !== "ESRCH") throw error; }
  };
  // Stop Cargo's compiler/linker descendants too, leaving room to upload evidence.
  signal("SIGTERM");
  killTimer ??= setTimeout(() => signal("SIGKILL"), 5000);
};
const sample = phase => {
  const { bavail, bsize } = statfsSync(process.cwd());
  const available = bavail * bsize;
  record(`${new Date().toISOString()} ${label}:${phase}: available=${available} required=${minimum} bytes\n`);
  if (available < minimum) throw new Error(`RUNNER_DISK_LOW: ${label}: available=${available}, required=${minimum} bytes; free build/cache space before retrying. Evidence: ${log}`);
};
const refuse = error => {
  refused = true;
  const message = `::error::${error.message}\n`;
  record(message);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, message);
  terminate();
};

try {
  if (!Number.isSafeInteger(minimum) || minimum <= 0) throw new Error("RUNNER_DISK_CONFIG: RUNNER_DISK_MIN_BYTES must be a positive integer");
  sample("before");
  if (command.length) {
    child = spawn(command[0], command.slice(1), { detached: true, stdio: ["inherit", "pipe", "pipe"] });
    child.stdout.on("data", data => record(data));
    child.stderr.on("data", data => record(data));
    const interrupted = () => { refused = true; terminate(); };
    process.on("SIGTERM", interrupted);
    process.on("SIGINT", interrupted);
    timer = setInterval(() => {
      try { sample("running"); } catch (error) { refuse(error); clearInterval(timer); }
    }, 5000);
    const code = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", code => resolve(code ?? 1));
    });
    clearInterval(timer);
    clearTimeout(killTimer);
    process.off("SIGTERM", interrupted);
    process.off("SIGINT", interrupted);
    child = undefined;
    sample("after");
    process.exitCode = refused ? 1 : code;
  }
} catch (error) {
  refuse(error);
  process.exitCode = 1;
} finally {
  clearInterval(timer);
  clearTimeout(killTimer);
}
