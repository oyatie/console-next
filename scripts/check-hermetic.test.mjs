// SPDX-License-Identifier: LicenseRef-Proprietary
// Run separately from npm test: this integration test invokes the entire npm run check gate.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const repo = path.resolve(import.meta.dirname, "..");

test("npm run check is hermetic; restoring the private queue dependency fails", { timeout: 900_000 }, (t) => {
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
  succeeds(run("npm", ["run", "check"]));

  const reach = path.join(checkout, "scripts/check-reach.mjs");
  const source = readFileSync(reach, "utf8");
  const boundary = source.indexOf("\n") + 1;
  writeFileSync(reach, source.slice(0, boundary) + 'import { queueDirDefault as privateQueue } from "./backlog-claims.mjs";\nif (!privateQueue()) throw new Error("hermetic negative control: missing orchestra queue");\n' + source.slice(boundary));
  const refused = run("npm", ["run", "check"]);
  assert.equal(refused.status, 1, refused.stdout + refused.stderr);
  assert.match(refused.stderr, /hermetic negative control: missing orchestra queue/);
});
