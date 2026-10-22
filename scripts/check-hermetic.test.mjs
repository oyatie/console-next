// SPDX-License-Identifier: LicenseRef-Proprietary
// Run separately from npm test: this integration test invokes the entire npm run check gate.
// The clean clone tests committed HEAD; commit changes before running it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const repo = path.resolve(import.meta.dirname, "..");

function assertRepoInputs(root) {
  const { scripts } = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const commands = new Set(["check"]);
  const files = new Set();
  const localState = /\/Users\/|\/home\/|\/private\/tmp\b|console-handoff|\bhomedir\s*\(/;
  for (const name of commands) {
    const command = scripts[name];
    assert.equal(typeof command, "string", `missing npm script: ${name}`);
    assert.doesNotMatch(command, localState, `npm ${name} depends on host state`);
    for (const [, nested] of command.matchAll(/\bnpm\s+(?:run\s+)?([\w:-]+)/g)) commands.add(nested);
    for (const [file] of command.matchAll(/\bscripts\/[\w./-]+\.(?:mjs|ts)\b/g)) files.add(path.join(root, file));
  }
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    assert.doesNotMatch(source, localState, `${path.relative(root, file)} depends on host state`);
    for (const [, spec] of source.matchAll(/(?:\bfrom\s*|^\s*import\s*)["'](\.[^"']+\.(?:mjs|ts))["']/gm)) files.add(path.resolve(path.dirname(file), spec));
  }
}

test("check refuses absolute host paths in its commands and imported helpers", (t) => {
  assertRepoInputs(repo);
  const root = mkdtempSync(path.join(tmpdir(), "check-inputs-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "scripts"));
  const manifest = path.join(root, "package.json");
  const scripts = { check: "npm run gate", gate: "node scripts/gate.mjs" };
  writeFileSync(manifest, JSON.stringify({ scripts }));
  writeFileSync(path.join(root, "scripts/gate.mjs"), 'import "./helper.mjs";\n');
  const helper = path.join(root, "scripts/helper.mjs");
  writeFileSync(helper, "");
  assertRepoInputs(root);
  for (const source of ['readFileSync("/Users/runner/private-state");', 'readFileSync("/home/runner/private-state");', 'readFileSync("/private/tmp/private-state");', 'readFileSync("../console-handoff/state");', 'readFileSync(homedir() + "/state");']) {
    writeFileSync(helper, source);
    assert.throws(() => assertRepoInputs(root), /scripts\/helper.mjs depends on host state/);
  }
  writeFileSync(helper, "");
  writeFileSync(manifest, JSON.stringify({ scripts: { ...scripts, gate: "node /Users/runner/gate.mjs" } }));
  assert.throws(() => assertRepoInputs(root), /npm gate depends on host state/);
});

test("npm run check is hermetic; restoring a home-state dependency fails", { timeout: 900_000 }, (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "console-check-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const checkout = path.join(dir, "checkout");
  const home = path.join(dir, "home");
  mkdirSync(home);
  const env = { PATH: process.env.PATH, HOME: home, TMPDIR: dir, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_STATE_HOME: path.join(home, ".local/state"), XDG_CACHE_HOME: path.join(home, ".cache") };
  const run = (cmd, args, cwd = checkout) => spawnSync(cmd, args, { cwd, env, encoding: "utf8", timeout: 600_000, maxBuffer: 64 * 1024 * 1024 });
  const succeeds = (result) => assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stdout}${result.stderr}`);
  succeeds(run("git", ["clone", "--quiet", "--no-local", "--single-branch", repo, checkout], dir));
  succeeds(run("git", ["checkout", "--quiet", "--detach"]));
  // Match ci.yml's full checkout and dev ref for the shrink-only ratchets.
  succeeds(run("git", ["fetch", "--quiet", "--no-tags", repo, "dev:refs/heads/dev"]));
  // Reuse the lockfile-installed tools without sharing application sources or local caches.
  cpSync(path.join(repo, "node_modules"), path.join(checkout, "node_modules"), { recursive: true, verbatimSymlinks: true });
  const { packages } = JSON.parse(readFileSync(path.join(checkout, "package-lock.json"), "utf8"));
  for (const [file, entry] of Object.entries(packages)) {
    if (!entry.link) continue;
    const link = path.join(checkout, file);
    rmSync(link, { force: true });
    symlinkSync(path.relative(path.dirname(link), path.join(checkout, entry.resolved)), link);
  }
  const status = run("git", ["status", "--porcelain"]);
  succeeds(status);
  assert.equal(status.stdout, "", "start from a clean checkout");
  assertRepoInputs(checkout);
  succeeds(run("npm", ["run", "check"]));

  const reach = path.join(checkout, "scripts/check-reach.mjs");
  const source = readFileSync(reach, "utf8");
  const boundary = source.indexOf("\n") + 1;
  writeFileSync(reach, source.slice(0, boundary) + 'import { homedir } from "node:os";\nreadFileSync(path.join(homedir(), ".config/console-orchestra/queue-dir"), "utf8");\n' + source.slice(boundary));
  assert.throws(() => assertRepoInputs(checkout), /scripts\/check-reach.mjs depends on host state/);
  const refused = run("npm", ["run", "check"]);
  assert.equal(refused.status, 1, refused.stdout + refused.stderr);
  assert.match(refused.stderr, /ENOENT.*console-orchestra\/queue-dir/);
});
