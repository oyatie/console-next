// SPDX-License-Identifier: LicenseRef-Proprietary
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { constants, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";

const dir = mkdtempSync(path.join(os.tmpdir(), "e2e-backend-process-"));
const bin = path.join(dir, "console-app");
const fixture = path.join(dir, "listener.cjs");
const children: ChildProcess[] = [];
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
      const child = require('node:child_process').spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); process.send('ready'); setInterval(() => {}, 1000)"], {
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { ...process.env, CONSOLE_APP_ROLE: 'child' }
      });
      const server = require('node:http').createServer((req, res) => {
        res.end(JSON.stringify({ pid: process.pid }));
        if (req.url === '/exit') setImmediate(() => process.exit(7));
      });
      // Keep a live descendant for group cleanup, even after SIGTERM stops the API.
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

async function eventually<T>(read: () => T | Promise<T>, accept: (value: T) => boolean): Promise<T> {
  const until = Date.now() + 20_000;
  let value: T;
  do {
    value = await read();
    if (accept(value)) return value;
    await delay(50);
  } while (Date.now() < until);
  throw new Error(`condition timed out: ${JSON.stringify(value)}`);
}

function record() {
  const file = path.join(dir, `listener-${sequence++}.json`);
  records.push(file);
  return file;
}

function env(file: string, port = 0) {
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

type Listener = { pid: number; child: number; port: number };
async function listener(file: string): Promise<Listener> {
  await eventually(() => existsSync(file), Boolean);
  const value = JSON.parse(readFileSync(file, "utf8")) as Listener;
  pids.add(value.pid);
  pids.add(value.child);
  return value;
}

function parent(pid: number) {
  return Number(spawnSync("ps", ["-p", String(pid), "-o", "ppid="], { encoding: "utf8" }).stdout.trim());
}

async function plant({ orphan = false, other = false, stubborn = false } = {}) {
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

function launchBackend(port: number, overrides: NodeJS.ProcessEnv = {}) {
  const file = record();
  const child = spawn(process.execPath, ["scripts/backend-dev.mjs"], { env: { ...env(file, port), ...overrides }, stdio: ["pipe", "pipe", "pipe"] });
  children.push(child);
  let output = "";
  child.stdout.on("data", (data) => { output += data; });
  child.stderr.on("data", (data) => { output += data; });
  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
  return { child, file, exited, output: () => output };
}

async function freePort() {
  const server = new net.Server();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function responds(port: number) {
  try { return await (await fetch(`http://127.0.0.1:${port}/readyz`)).json() as { pid: number }; }
  catch { return null; }
}

function alive(pid: number) {
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

test.each([
  { stubborn: false, adopted: false }, { stubborn: true, adopted: false },
  { stubborn: false, adopted: true }, { stubborn: true, adopted: true },
])("a console-app orphan is reaped and the next backend binds its port: %j", async ({ stubborn, adopted }) => {
  const orphan = await plant({ orphan: true, stubborn });
  const run = launchBackend(orphan.port, {
    E2E_CACHE_DIR: orphan.cache,
    ...(adopted ? { ADOPTED_LISTENER_PID: String(orphan.pid), ADOPTER_PID: String(process.pid) } : {}),
  });
  await eventually(() => existsSync(run.file) || run.child.exitCode !== null, Boolean);
  expect(run.child.exitCode, run.output()).toBeNull();
  const next = await listener(run.file);
  expect(JSON.parse(readFileSync(path.join(orphan.cache, "backend.json"), "utf8"))).toMatchObject({ pid: run.child.pid, apiPid: next.pid });
  expect(next.pid).not.toBe(orphan.pid);
  expect(await responds(orphan.port)).toEqual({ pid: next.pid });
  expect(alive(orphan.pid)).toBe(false);
  expect(alive(orphan.child)).toBe(true);
  await eventually(run.output, (output) => output.includes("[backend] ready"));
}, 30_000);

test.each([{ orphan: false, other: false }, { orphan: true, other: true }])("an unsafe listener is refused without killing it: %j", async (options) => {
  const occupied = await plant(options);
  const run = launchBackend(occupied.port, { E2E_CACHE_DIR: occupied.cache });
  expect(await run.exited, run.output()).not.toBe(0);
  expect(run.output()).toContain(`port ${occupied.port} is held by pid ${occupied.pid}`);
  expect(run.output()).toContain("refusing to stop");
  expect(await responds(occupied.port)).toEqual({ pid: occupied.pid });
});

test.each(["missing", "malformed", "wrong listener", "invalid launcher"])("an orphan without valid slot ownership is refused: %s", async (record) => {
  const occupied = await plant({ orphan: true });
  const file = path.join(occupied.cache, "backend.json");
  if (record === "missing") rmSync(file);
  else writeFileSync(file, record === "malformed" ? "{" : JSON.stringify({
    pid: record === "invalid launcher" ? -1 : occupied.launcher,
    apiPid: record === "wrong listener" ? occupied.child : occupied.pid,
  }));
  const run = launchBackend(occupied.port, { E2E_CACHE_DIR: occupied.cache });
  expect(await run.exited, run.output()).not.toBe(0);
  expect(run.output()).toContain(`port ${occupied.port} is held by pid ${occupied.pid}`);
  expect(run.output()).toContain("refusing to stop");
  expect(await responds(occupied.port)).toEqual({ pid: occupied.pid });
});

test("a legacy orphan record names the listener and the exact manual cleanup step", async () => {
  const occupied = await plant({ orphan: true });
  writeFileSync(path.join(occupied.cache, "backend.json"), JSON.stringify({ pid: occupied.launcher, bin }));
  const run = launchBackend(occupied.port, {
    E2E_CACHE_DIR: occupied.cache,
    ADOPTED_LISTENER_PID: String(occupied.pid), ADOPTER_PID: "1",
  });
  expect(await run.exited, run.output()).not.toBe(0);
  expect(run.output()).toContain(`port ${occupied.port} is held by pid ${occupied.pid}`);
  expect(run.output()).toContain("legacy slot record has no apiPid");
  expect(run.output()).toContain(`run \`kill -TERM ${occupied.pid}\` and retry`);
  expect(await responds(occupied.port)).toEqual({ pid: occupied.pid });
});

test.each([{ orphan: false, other: false }, { orphan: true, other: true }])("a legacy record never suggests killing a live or foreign listener: %j", async (options) => {
  const occupied = await plant(options);
  writeFileSync(path.join(occupied.cache, "backend.json"), JSON.stringify({ pid: occupied.launcher }));
  const run = launchBackend(occupied.port, { E2E_CACHE_DIR: occupied.cache });
  expect(await run.exited, run.output()).not.toBe(0);
  expect(run.output()).not.toContain("kill -TERM");
  expect(await responds(occupied.port)).toEqual({ pid: occupied.pid });
});

test("Playwright starts the launcher even when a recorded orphan answers readyz", async () => {
  const orphan = await plant({ orphan: true });
  const config = path.join(dir, "playwright.config.mjs");
  const spec = path.join(dir, "orphan.spec.mjs");
  writeFileSync(config, `
    import config from ${JSON.stringify(path.resolve("playwright.config.ts"))};
    export default {
      testDir: ${JSON.stringify(dir)}, testMatch: 'orphan.spec.mjs', workers: 1,
      webServer: {
        ...config.webServer[0], cwd: ${JSON.stringify(process.cwd())}, timeout: 30_000,
        env: { ...config.webServer[0].env, E2E_CACHE_DIR: ${JSON.stringify(orphan.cache)} },
      },
      use: { browserName: 'chromium', headless: true },
      outputDir: ${JSON.stringify(path.join(dir, "results"))},
    };
  `);
  writeFileSync(spec, `
    import { test, expect } from ${JSON.stringify(path.resolve("node_modules/@playwright/test/index.mjs"))};
    test('reclaimed backend responds in Chromium', async ({ page }) => {
      await page.goto('http://127.0.0.1:${orphan.port}/readyz');
      expect(JSON.parse(await page.locator('body').innerText()).pid).not.toBe(${orphan.pid});
    });
  `);
  const file = record();
  const child = spawn(process.execPath, ["node_modules/@playwright/test/cli.js", "test", "-c", config], {
    env: { ...env(file, orphan.port), E2E_CACHE_DIR: orphan.cache, E2E_REUSE: "0" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.push(child);
  let output = "";
  child.stdout.on("data", (data) => { output += data; });
  child.stderr.on("data", (data) => { output += data; });
  const code = await new Promise((resolve) => child.once("exit", resolve));
  expect(code, output).toBe(0);
  expect(alive(orphan.pid)).toBe(false);
  const next = await listener(file);
  await eventually(() => [alive(next.pid), alive(next.child)], (values) => values.every((value) => !value));
}, 45_000);

test("SIGUSR2 restarts only this launcher's group on the same port", async () => {
  const port = await freePort();
  const cache = mkdtempSync(path.join(dir, "publication-"));
  const run = launchBackend(port, { RECORD_WRITE_PROBE: "1", E2E_CACHE_DIR: cache });
  const first = await listener(run.file);
  await eventually(run.output, (output) => output.includes("record-while-open:"));
  expect(run.output()).toContain("record-while-open: null");
  const previous = readFileSync(path.join(cache, "backend.json"), "utf8");
  run.child.kill("SIGUSR2");
  await eventually(() => [alive(first.pid), alive(first.child)], (values) => values.every((value) => !value));
  expect(run.child.exitCode).toBeNull();
  run.child.kill("SIGUSR2");
  await eventually(() => JSON.parse(readFileSync(run.file, "utf8")) as Listener, (value) => value.pid !== first.pid);
  const second = await listener(run.file);
  await eventually(run.output, (output) => output.includes(`record-while-open: ${JSON.stringify(previous)}`));
  expect(await responds(port)).toEqual({ pid: second.pid });
});

test.each(["SIGINT", "SIGTERM", "exit", "stdin"] as const)("the backend process group is stopped on launcher %s", async (reason) => {
  const port = await freePort();
  const run = launchBackend(port);
  const api = await listener(run.file);
  const pgid = Number(spawnSync("ps", ["-p", String(api.pid), "-o", "pgid="], { encoding: "utf8" }).stdout.trim());
  expect(pgid).toBe(api.pid);
  if (reason === "exit") await fetch(`http://127.0.0.1:${port}/exit`);
  else if (reason === "stdin") run.child.stdin.end();
  else run.child.kill(reason);
  expect(await run.exited).toBe(reason === "exit" ? 7 : reason === "SIGINT" ? 130 : reason === "SIGTERM" ? 143 : 1);
  await eventually(() => [alive(api.pid), alive(api.child)], (values) => values.every((value) => !value));
});
