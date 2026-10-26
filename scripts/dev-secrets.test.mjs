// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
      CONSOLE_DEV_BACKEND_PORT: "0",
      CONSOLE_DEV_S3_PORT: "1",
      E2E_CACHE_DIR: path.join(dir, "cache"),
    },
  });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(run.stdout.includes(DEV_SECRETS_FILE), run.stdout);
  const secrets = JSON.parse(readFileSync(DEV_SECRETS_FILE, "utf8"));
  for (const value of Object.values(secrets)) assert.ok(!run.stdout.includes(value), "a secret value was printed");
});
