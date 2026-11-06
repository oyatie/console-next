// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("./ci-affected.mjs", import.meta.url));
const backend = { backend: true, web: false };
const web = { backend: false, web: true };
const both = { backend: true, web: true };

for (const [name, files, expected] of [
  ["backend", ["backend/app/src/main.rs", "backend/Cargo.lock"], backend],
  ["root Rust inputs", ["Cargo.toml", "Cargo.lock", "rust-toolchain", "rust-toolchain.toml"], backend],
  ["migration and API inputs", ["migrations/change.sql", "openapi.yaml", "openapi/schema.json"], backend],
  ["web", ["apps/web/src/main.tsx", "packages/api/src/schema.d.ts", "e2e/home.spec.ts", "package.json", "package-lock.json"], web],
  ["CI and tooling", [".github/workflows/ci.yml", "scripts/check.mjs"], both],
  ["documentation", ["README.md", "CONTRIBUTING.md", "docs/apps/x.md"], { backend: false, web: false }],
  ["unknown", ["new-area/source.txt", ".cargo/config.toml", "tsconfig.json", "deploy/backend/x.rs"], both],
  ["shared backend contracts", ["backend/openapi/openapi.yaml", "backend/openapi/ops.yaml", "backend/openapi/schemas/Example.yaml"], both],
]) {
  test(`classifies each ${name} path`, async () => {
    const { classifyPaths } = await import("./ci-affected.mjs");
    for (const file of files) assert.deepEqual(classifyPaths([file]), expected, file);
  });
}

test("combines classes and leaves an empty diff unaffected", async () => {
  const { classifyPaths } = await import("./ci-affected.mjs");
  assert.deepEqual(classifyPaths(["backend/app.rs", "apps/web/index.ts"]), both);
  assert.deepEqual(classifyPaths([]), { backend: false, web: false });
});

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "ci-affected-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Jason Lee", GIT_AUTHOR_EMAIL: "56489493+jason931225@users.noreply.github.com",
    GIT_COMMITTER_NAME: "Jason Lee", GIT_COMMITTER_EMAIL: "56489493+jason931225@users.noreply.github.com" };
  const git = (...args) => execFileSync("git", args, { cwd: root, env, encoding: "utf8" }).trim();
  const write = (file, text = "fixture\n") => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  };
  const commit = () => {
    git("add", ".");
    git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "test: affected paths fixture");
    return git("rev-parse", "HEAD");
  };
  git("init", "-q", "--initial-branch=dev");
  write("README.md");
  const base = commit();
  const run = (event = "pull_request", from = base, head = git("rev-parse", "HEAD")) => {
    const output = path.join(root, "output");
    writeFileSync(output, "");
    const result = spawnSync(process.execPath, [script, event, from, head], {
      cwd: root, env: { ...env, GITHUB_OUTPUT: output }, encoding: "utf8",
    });
    return { ...result, output: readFileSync(output, "utf8") };
  };
  return { root, git, write, commit, base, run };
}

test("PR and merge queue classify the candidate against the merge base, excluding later base-only changes", (t) => {
  const f = fixture(t);
  f.git("checkout", "-qb", "candidate");
  f.write("apps/web/page.tsx");
  const head = f.commit();
  f.git("checkout", "-q", "dev");
  f.write("backend/base-only.rs");
  const base = f.commit();
  for (const event of ["pull_request", "merge_group"]) {
    const result = f.run(event, base, head);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.output, "backend=false\nweb=true\n");
  }
});

for (const [before, after] of [
  ["backend/renamed.rs", "apps/web/renamed.ts"],
  ["apps/web/renamed.ts", "backend/renamed.rs"],
  ["apps/web/renamed.ts", "unclassified/renamed.ts"],
]) {
  test(`rename from ${before} to ${after} affects both classes`, (t) => {
    const f = fixture(t);
    f.write(before);
    const base = f.commit();
    f.write(after);
    f.git("rm", "-q", before);
    const head = f.commit();
    assert.match(f.git("diff", "--name-status", "--find-renames", base, head), /^R100/);
    const result = f.run("pull_request", base, head);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.output, "backend=true\nweb=true\n");
  });
}

test("deleted paths and filenames containing tabs and newlines stay in the diff", (t) => {
  const f = fixture(t);
  f.write("backend/deleted.rs");
  const base = f.commit();
  f.git("rm", "-q", "backend/deleted.rs");
  f.write("apps/web/tab\tand\nnewline.ts");
  const result = f.run("merge_group", base, f.commit());
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.output, "backend=true\nweb=true\n");
});

test("push always affects both classes without needing a base revision", (t) => {
  const result = fixture(t).run("push", "", "");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.output, "backend=true\nweb=true\n");
});

test("unsupported events fail without publishing outputs", (t) => {
  const result = fixture(t).run("workflow_dispatch");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /CI_AFFECTED_EVENT/);
  assert.equal(result.output, "");
});

test("missing or malformed revisions fail without publishing outputs", (t) => {
  const f = fixture(t);
  for (const [base, head] of [["", f.base], [f.base, ""], ["--help", f.base], [f.base, "HEAD"]]) {
    const result = f.run("pull_request", base, head);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /CI_AFFECTED_SHA/);
    assert.equal(result.output, "");
  }
});

test("unavailable commits fail without publishing outputs", (t) => {
  const f = fixture(t);
  const result = f.run("merge_group", "0".repeat(40), f.base);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Command failed: git merge-base/);
  assert.equal(result.output, "");
});
