// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { DEV_SECRETS_FILE, ensureDevSecrets } from "./dev-secrets.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

test("per-checkout secrets are random, made once and kept in a mode-600 file", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "console-dev-secrets-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "s", "dev-secrets.json");
  const first = ensureDevSecrets(file);
  assert.deepEqual(ensureDevSecrets(file), first, "a second run reuses the file");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.match(first.coldstartOtp, /^[A-HJ-NP-Z2-9]{8}$/);
  assert.notEqual(first.coldstartOtp.toLowerCase(), "coss0000");
  assert.match(first.postgresAppPassword, /^[0-9a-f]{64}$/);
  const other = ensureDevSecrets(path.join(dir, "t", "dev-secrets.json"));
  assert.notEqual(other.postgresAppPassword, first.postgresAppPassword, "another checkout gets its own");
});

test("backend-dev prints where the secrets are, never a secret", (t) => {
  assert.equal(spawnSync("git", ["check-ignore", "-q", DEV_SECRETS_FILE], { cwd: root }).status, 0, "the file is git-ignored");
  const dir = mkdtempSync(path.join(os.tmpdir(), "console-backend-dev-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, "bin"));
  for (const fake of ["bin/docker", "console-app"]) writeFileSync(path.join(dir, fake), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const run = spawnSync(process.execPath, ["scripts/backend-dev.mjs"], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
    env: {
      ...process.env,
      PATH: `${path.join(dir, "bin")}:${process.env.PATH ?? ""}`,
      CONSOLE_APP_BIN: path.join(dir, "console-app"),
      CONSOLE_DEV_PROJECT: "dev-secrets-test",
      CONSOLE_DEV_S3_PORT: "1",
      E2E_CACHE_DIR: path.join(dir, "cache"),
    },
  });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(run.stdout.includes(DEV_SECRETS_FILE), run.stdout);
  const secrets = JSON.parse(readFileSync(DEV_SECRETS_FILE, "utf8"));
  for (const value of Object.values(secrets)) assert.ok(!run.stdout.includes(value), "a secret value was printed");
});

for (const outcome of ["exit", "startup-failure", "SIGTERM", "SIGINT"]) test(`reset backend releases its own Docker network and volumes on ${outcome}`, async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "console-e2e-teardown-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, "bin"));
  const receipt = path.join(dir, "docker.jsonl");
  writeFileSync(path.join(dir, "bin/docker"), `#!${process.execPath}\nconst f=require('node:fs');f.appendFileSync(process.env.DOCKER_RECEIPT,JSON.stringify(process.argv.slice(2))+'\\n');if(process.env.FAIL_COMPOSE_UP==='1'&&process.argv.includes('up'))process.exit(1);\n`, { mode: 0o700 });
  writeFileSync(path.join(dir, "console-app"), `#!${process.execPath}\nif(process.env.CONSOLE_APP_ROLE==='migrate'||process.env.API_EXIT==='1')process.exit(0);console.log('test API running');setInterval(()=>{},1000);\n`, { mode: 0o700 });
  const child = spawn(process.execPath, ["scripts/backend-dev.mjs", "--reset"], {
    cwd: root, detached: true, env: { ...process.env, PATH: `${path.join(dir, "bin")}:${process.env.PATH}`, DOCKER_CONTEXT: "synthetic", DOCKER_RECEIPT: receipt,
      CONSOLE_APP_BIN: path.join(dir, "console-app"), CONSOLE_DEV_PROJECT: "synthetic-teardown", CONSOLE_DEV_S3_PORT: "1", E2E_CACHE_DIR: path.join(dir, "cache"),
      FAIL_COMPOSE_UP: outcome === "startup-failure" ? "1" : "0", API_EXIT: outcome === "exit" ? "1" : "0" },
  });
  t.after(() => { try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; } });
  let output = "";
  child.stdout.on("data", (data) => { output += data; if (output.includes("test API running") && outcome.startsWith("SIG")) child.kill(outcome); });
  child.stderr.resume();
  const [code, signal] = await once(child, "exit", { signal: AbortSignal.timeout(15_000) });
  assert.equal(signal, null);
  assert.equal(code, outcome === "startup-failure" ? 1 : 0);
  const commands = readFileSync(receipt, "utf8").trim().split("\n").map(JSON.parse);
  assert.ok(commands.some((args) => args.includes("up")));
  assert.deepEqual(commands.at(-1), ["compose", "-p", "synthetic-teardown", "-f", "e2e/stack/compose.yml", "down", "-v", "--remove-orphans"]);
});
