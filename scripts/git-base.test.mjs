// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { resolveBase } from "./git-base.mjs";
import { atBase } from "./quality/ratchet.mjs";

function repository(t) {
  const root = mkdtempSync(path.join(tmpdir(), "console-git-base-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "dev");
  writeFileSync(path.join(root, "safe.txt"), "base\n");
  git("add", ".");
  git("-c", "user.name=Jason Lee", "-c", "user.email=56489493+jason931225@users.noreply.github.com", "commit", "-qm", "test: base");
  const base = git("rev-parse", "HEAD");
  git("update-ref", "refs/remotes/origin/dev", base);
  git("checkout", "--detach", "-q");
  git("branch", "-D", "dev");
  return { root, git, base };
}

test("detached checkout resolves origin/dev, then the public remote; a local dev never wins", (t) => {
  const { root, git, base } = repository(t);
  assert.equal(resolveBase(root, { env: {} }), base);
  assert.equal(atBase(root, base, "safe.txt"), "base\n");
  git("update-ref", "refs/remotes/public/dev", base);
  git("update-ref", "-d", "refs/remotes/origin/dev");
  assert.equal(resolveBase(root, { env: {} }), base);
  git("branch", "dev", base);
  git("update-ref", "-d", "refs/remotes/public/dev");
  assert.throws(() => resolveBase(root, { env: {} }), /CI_BASE_SHA.*origin\/dev.*public\/dev/);
});

test("explicit base, CI SHA and event SHA precede remote refs; invalid evidence refuses", (t) => {
  const { root, git, base } = repository(t);
  const event = path.join(root, "event.json");
  git("update-ref", "-d", "refs/remotes/origin/dev");
  for (const payload of [{ pull_request: { base: { sha: base } } }, { merge_group: { base_sha: base } }, { before: base }]) {
    writeFileSync(event, JSON.stringify(payload));
    assert.equal(resolveBase(root, { env: { GITHUB_EVENT_PATH: event } }), base);
  }
  writeFileSync(event, JSON.stringify({ pull_request: { base: { sha: "missing-event-base" } } }));
  assert.equal(resolveBase(root, { env: { GITHUB_EVENT_PATH: event, CI_BASE_SHA: base } }), base);
  assert.equal(resolveBase(root, { base, env: { CI_BASE_SHA: "missing-ci-base" } }), base);
  for (const env of [{ CI_BASE_SHA: "missing-ci-base" }, { GITHUB_EVENT_PATH: event }]) {
    assert.throws(() => resolveBase(root, { env }), /cannot resolve.*base.*CI_BASE_SHA/);
  }
  assert.throws(() => resolveBase(root, { base: "missing-explicit-base", env: {} }), /cannot resolve.*base.*CI_BASE_SHA/);
  writeFileSync(event, "invalid JSON");
  assert.throws(() => resolveBase(root, { env: { GITHUB_EVENT_PATH: event } }), /event.*CI_BASE_SHA/);
  writeFileSync(event, JSON.stringify({ before: "0".repeat(40) }));
  assert.throws(() => resolveBase(root, { env: { CI_BASE_SHA: "", GITHUB_EVENT_PATH: event } }), /CI_BASE_SHA.*origin\/dev/);
});

test("licence and file-policy CLIs work in a detached checkout and refuse unavailable bases", (t) => {
  const { root, git, base } = repository(t);
  const env = { ...process.env, CI_BASE_SHA: "", GITHUB_EVENT_PATH: "", QUALITY_BASE: "" };
  for (const file of ["check-license-headers.mjs", "check-repo-files.mjs"]) {
    const run = (extraEnv = {}) => spawnSync(process.execPath, [new URL(`./${file}`, import.meta.url).pathname], { cwd: root, encoding: "utf8", env: { ...env, ...extraEnv } });
    assert.equal(run().status, 0, run().stderr);
    git("update-ref", "-d", "refs/remotes/origin/dev");
    const refused = run();
    assert.equal(refused.status, 1, refused.stdout);
    assert.match(refused.stderr, /CI_BASE_SHA.*origin\/dev/);
    assert.equal(run({ CI_BASE_SHA: base }).status, 0);
    git("update-ref", "refs/remotes/origin/dev", base);
  }
});
