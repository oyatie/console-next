// SPDX-License-Identifier: LicenseRef-Proprietary
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { constants, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, expect } from "vitest";

export const dir = mkdtempSync(path.join(os.tmpdir(), "e2e-backend-process-"));
export const bin = path.join(dir, "console-app");
const fixture = path.join(dir, "listener.cjs");
export const children: ChildProcess[] = [];
const records: string[] = [];
const pids = new Set<number>();
let sequence = 0;

beforeAll(() => {
  copyFileSync(process.execPath, bin, constants.COPYFILE_FICLONE);
  mkdirSync(path.join(dir, "bin"));
  writeFileSync(path.join(dir, "bin/docker"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const lsof = spawnSync("which", ["lsof"], { encoding: "utf8" }).stdout.trim();
  writeFileSync(path.join(dir, "bin/lsof"), `#!/usr/bin/env node
    const args = process.argv.slice(2);
    const result = require('node:child_process').spawnSync(${JSON.stringify(lsof)}, args, { encoding: 'utf8' });
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    if (process.env.CI && !args.includes('-w')) process.stderr.write('lsof: WARNING: cannot stat() overlay file system\\n');
    process.exit(result.status ?? 1);
  `, { mode: 0o700 });
  const ps = spawnSync("which", ["ps"], { encoding: "utf8" }).stdout.trim();
  // Model Linux adoption by a live subreaper even when this suite runs on macOS.
  writeFileSync(path.join(dir, "bin/ps"), `#!/usr/bin/env node
    const result = require('node:child_process').spawnSync(${JSON.stringify(ps)}, process.argv.slice(2), { encoding: 'utf8' });
    const adopted = process.argv[3] === process.env.ADOPTED_LISTENER_PID;
    process.stdout.write(adopted ? result.stdout.replace(/^\\s*\\d+/, process.env.ADOPTER_PID) : result.stdout);
    process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  `, { mode: 0o700 });
  writeFileSync(fixture, `
    const fs = require('node:fs');
    if (process.env.RECORD_WRITE_PROBE === '1') {
      const record = require('node:path').join(process.env.E2E_CACHE_DIR, 'backend.json');
      const write = fs.writeFileSync;
      // Inspect publication while the output file is open, without a scheduling race.
      fs.writeFileSync = (file, data, options) => {
        if (!String(file).startsWith(record)) return write(file, data, options);
        const fd = fs.openSync(file, 'w');
        try {
          console.log('record-while-open: ' + JSON.stringify(fs.existsSync(record) ? fs.readFileSync(record, 'utf8') : null));
          return write(fd, data, options);
        } finally { fs.closeSync(fd); }
      };
    }
    if (process.env.CONSOLE_APP_ROLE === 'migrate') process.exit(0);
    if (process.env.CONSOLE_APP_ROLE === 'api') {
      process.title = require('node:path').basename(process.execPath);
      if (process.env.IGNORE_TERM === '1') process.on('SIGTERM', () => {});
      const child = require('node:child_process').spawn(process.execPath, ['-e', "if (process.env.CHILD_IGNORE_TERM === '1') process.on('SIGTERM', () => {}); process.send('ready'); setInterval(() => {}, 1000)"], {
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { ...process.env, CONSOLE_APP_ROLE: 'child' }
      });
      const server = require('node:http').createServer((req, res) => {
        res.end(JSON.stringify({ pid: process.pid }));
        if (req.url === '/exit') setImmediate(() => process.exit(7));
      });
      // IPC readiness ensures SIGTERM tests include the descendant.
      child.once('message', () => server.listen(Number(process.env.CONSOLE_DEV_BACKEND_PORT || 0), '127.0.0.1', () => {
        const temporary = process.env.LISTENER_RECORD + '.' + process.pid + '.tmp';
        fs.writeFileSync(temporary, JSON.stringify({
          pid: process.pid, child: child.pid, port: server.address().port
        }));
        fs.renameSync(temporary, process.env.LISTENER_RECORD);
      }));
    }
  `);
});

export async function eventually<T>(read: () => T | Promise<T>, accept: (value: T) => boolean): Promise<T> {
  const until = Date.now() + 20_000;
  let value: T;
  do {
    value = await read();
    if (accept(value)) return value;
    await delay(50);
  } while (Date.now() < until);
  throw new Error(`condition timed out: ${JSON.stringify(value)}`);
}

export function record() {
  const file = path.join(dir, `listener-${sequence++}.json`);
  records.push(file);
  return file;
}

export function env(file: string, port = 0) {
  return {
    ...process.env,
    PATH: `${path.join(dir, "bin")}:${process.env.PATH}`,
    NODE_OPTIONS: `--require=${JSON.stringify(fixture)}`,
    CONSOLE_REPO: dir,
    CONSOLE_APP_BIN: bin,
    CONSOLE_DEV_BACKEND_PORT: String(port),
    CONSOLE_DEV_S3_PORT: "1",
    CONSOLE_EMAIL_STUB_MODE: "e2e",
    CONSOLE_SUPPORT_LOG_QUERY_URL: "http://127.0.0.1:1",
    E2E_CACHE_DIR: path.join(dir, `cache-${sequence}`),
    LISTENER_RECORD: file,
  };
}

export type Listener = { pid: number; child: number; port: number };
export async function listener(file: string): Promise<Listener> {
  await eventually(() => existsSync(file), Boolean);
  const value = JSON.parse(readFileSync(file, "utf8")) as Listener;
  pids.add(value.pid);
  pids.add(value.child);
  return value;
}

function parent(pid: number) {
  return Number(spawnSync("ps", ["-p", String(pid), "-o", "ppid="], { encoding: "utf8" }).stdout.trim());
}

export async function plant({ orphan = false, other = false, stubborn = false } = {}) {
  const file = record();
  const command = other ? process.execPath : bin;
  const options = { env: { ...env(file), CONSOLE_APP_ROLE: "api", IGNORE_TERM: stubborn ? "1" : "0" }, stdio: "ignore" as const };
  const cache = options.env.E2E_CACHE_DIR;
  mkdirSync(cache, { recursive: true });
  let launcher = process.pid;
  if (orphan) {
    const planter = spawnSync(process.execPath, ["-e", `
      const child = require('node:child_process').spawn(${JSON.stringify(command)}, [], { ...${JSON.stringify(options)}, detached: true });
      require('node:fs').writeFileSync(${JSON.stringify(path.join(cache, "backend.json"))}, JSON.stringify({ pid: process.pid, apiPid: child.pid }));
      child.unref();
    `], { encoding: "utf8", env: process.env });
    expect(planter.status, planter.stderr).toBe(0);
    launcher = planter.pid;
  } else children.push(spawn(command, [], options));
  const value = await listener(file);
  if (orphan) {
    expect(alive(launcher)).toBe(false);
    await eventually(() => parent(value.pid), (pid) => pid !== launcher);
  } else {
    expect(parent(value.pid)).toBe(launcher);
    writeFileSync(path.join(cache, "backend.json"), JSON.stringify({ pid: launcher, apiPid: value.pid }));
  }
  return { ...value, cache, launcher };
}

export function launchBackend(port: number, overrides: NodeJS.ProcessEnv = {}) {
  const file = record();
  const child = spawn(process.execPath, ["scripts/backend-dev.mjs"], { env: { ...env(file, port), ...overrides }, stdio: ["pipe", "pipe", "pipe"] });
  children.push(child);
  let output = "";
  child.stdout.on("data", (data) => { output += data; });
  child.stderr.on("data", (data) => { output += data; });
  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
  return { child, file, exited, output: () => output };
}

export async function freePort() {
  const server = new net.Server();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

export async function responds(port: number) {
  try { return await (await fetch(`http://127.0.0.1:${port}/readyz`)).json() as { pid: number }; }
  catch { return null; }
}

export function alive(pid: number) {
  const result = spawnSync("ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8" });
  return result.status === 0 && !result.stdout.trim().startsWith("Z");
}

afterEach(async () => {
  for (const file of records.splice(0)) if (existsSync(file)) {
    const value = JSON.parse(readFileSync(file, "utf8")) as Listener;
    pids.add(value.pid);
    pids.add(value.child);
  }
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill("SIGKILL");
  for (const pid of pids) {
    try { process.kill(pid, "SIGKILL"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  }
  pids.clear();
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
