// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { load } from "js-yaml";

const guard = () => import("./check-repo-files.mjs");
const samples = [
  ["private-tools", ["tools/x.sh", "tools/nested/x.sh"], ["scripts/x.sh"]],
  ["private-ops-docs", ["docs/ops/x.md", "docs/ops/mvp-build.md/x"], ["docs/ops/mvp-build.md", "docs/x.md"]],
  ["private-ops", ["ops/x.yaml", "ops/nested/x.yaml"], ["deploy/x.yaml", "scripts/ci/postgres-reconcile-topology.sh"]],
  ["environment", [".env", ".env.local", "app/.env.example", "app/.ENV.prod", ".env.d/x", "app/.env.d/x"], ["app/env.example", "app/x.env"]],
  ["bundle", [".bundle", "x.bundle", "app/x.bundle"], ["app/x.bundle.mjs"]],
  ["key-material", ["x.pem", "x.key", "x.p12", "x.pfx", "id_rsa", "app/id_rsa.pub", "id_ed25519", "app/id_ed25519.pub"], ["app/keys.md", "app/x.pem.md"]],
  ["terraform-state", ["x.tfstate", "app/x.tfstate.backup"], ["app/x.tf", "app/tfstate.md"]],
  ["database-file", ["x.sqlite", "app/x.dump"], ["app/x.sql", "app/x.sqlite.rs"]],
  ["spreadsheet", ["x.xls", "app/x.xlsx", "app/x.XLSX", "backend/crates/platform/excel/templates-other/x.xlsx", "app/test/fixtures/x.xlsx", "backend/fuzz/regressions-other/x.xlsx"], [
    "backend/crates/platform/excel/templates/x.xlsx", "backend/crates/platform/excel/templates/nested/x.xls",
    "tests/fixtures/x.xlsx", "app/tests/fixtures/nested/x.xlsx", "app/tests/fixtures/x.xls",
    "backend/fuzz/regressions/x.xlsx", "backend/fuzz/regressions/nested/x.xls",
  ]],
  ["personal-data-document", ["x.hwp", "app/x.hwpx", "app/x.pdf", "app/x.doc", "app/x.docx", "app/x.zip", "tests/fixtures/x.pdf", "backend/fuzz/regressions/x.zip", "deploy/x.PDF"], ["app/x.md", "deploy/x.yaml"]],
];

for (const [rule, refused, allowed] of samples) {
  test(`${rule}: refuses restricted paths and permits its controls`, async () => {
    const { fileProblems } = await guard();
    for (const file of refused) assert.ok(fileProblems(file, 1).includes(rule), `${file}: missing ${rule}`);
    for (const file of allowed) assert.deepEqual(fileProblems(file, 1), [], file);
  });
}

test("max-file-size: exactly 5 MB passes; one byte over fails even in exceptions", async () => {
  const { fileProblems, policy } = await guard();
  assert.equal(policy.maxFileBytes, 5_000_000);
  for (const file of ["deploy/x.yaml", "docs/ops/mvp-build.md", "app/tests/fixtures/x.xlsx"]) {
    assert.deepEqual(fileProblems(file, policy.maxFileBytes), [], file);
    assert.ok(fileProblems(file, policy.maxFileBytes + 1).includes("max-file-size"), file);
  }
});

test("policy covers every refusal and names the relocated, scanned topology files", async () => {
  const { policy, fileProblems } = await guard();
  assert.deepEqual(policy.rules.map((rule) => rule.id).sort(), samples.map(([id]) => id).sort());
  const ops = policy.rules.find((rule) => rule.id === "private-ops");
  assert.deepEqual(ops.allow, [], "no curated files remain under ops in round 3");
  assert.deepEqual(policy.curatedTopologyFiles, ["e2e/stack/compose.yml", "e2e/stack/otel-collector.yml", "scripts/ci/postgres-reconcile-topology.sh"]);
  for (const file of policy.curatedTopologyFiles) {
    assert.ok(readFileSync(new URL(`../${file}`, import.meta.url)).length > 0, file);
    assert.deepEqual(fileProblems(file, 1), [], file);
  }
});

function repository(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "repo-file-guard-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, CI_BASE_SHA: "", GITHUB_EVENT_PATH: "", QUALITY_BASE: "", GIT_AUTHOR_NAME: "Jason Lee", GIT_AUTHOR_EMAIL: "56489493+jason931225@users.noreply.github.com", GIT_COMMITTER_NAME: "Jason Lee", GIT_COMMITTER_EMAIL: "56489493+jason931225@users.noreply.github.com" };
  const git = (...args) => execFileSync("git", args, { cwd: dir, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const write = (file, value = "synthetic control\n") => {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), value);
  };
  const commit = () => { git("add", "-A"); git("commit", "-qm", "test: repository file controls"); };
  const run = (...args) => spawnSync(process.execPath, [new URL("./check-repo-files.mjs", import.meta.url).pathname, ...args], { cwd: dir, env, encoding: "utf8" });
  git("init", "-q", "-b", "dev");
  return { dir, git, write, commit, run };
}

test("CLI checks committed merge-base..HEAD paths, renames and deletions; full mode checks the tree", async (t) => {
  const { policy } = await guard();
  const { dir, git, write, commit, run } = repository(t);
  write(".env.preexisting");
  write("docs/existing.pdf");
  write("rename.txt");
  commit();
  git("checkout", "-qb", "feature");
  write("deploy/x.yaml");
  write(".env.new");
  write("large.txt", "");
  truncateSync(path.join(dir, "large.txt"), policy.maxFileBytes + 1);
  write("tools/private\nname.txt");
  commit();
  // Local edits must not hide the blobs which Actions will check out.
  rmSync(path.join(dir, ".env.new"));
  truncateSync(path.join(dir, "large.txt"), 0);
  let result = run("dev");
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /\.env\.new.*environment/);
  assert.match(result.stderr, /large\.txt.*max-file-size/);
  assert.match(result.stderr, /tools\/private\\nname\.txt.*private-tools/);
  assert.doesNotMatch(result.stderr, /preexisting|existing\.pdf/);
  result = run("--full");
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /\.env\.preexisting.*environment/);
  assert.match(result.stderr, /docs\/existing\.pdf.*personal-data-document/);

  rmSync(path.join(dir, "tools"), { recursive: true });
  rmSync(path.join(dir, "docs/existing.pdf"));
  commit();
  assert.equal(run("dev").status, 0, "deletions and ignored/untracked files are not additions");
  git("mv", "rename.txt", "id_rsa.pub");
  commit();
  result = run("dev");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /id_rsa\.pub.*key-material/);
  git("rm", "id_rsa.pub");
  commit();
  git("checkout", "-q", "dev");
  write("ops/base-only.yaml");
  commit();
  git("checkout", "-q", "feature");
  write(".env.untracked");
  result = run("dev");
  assert.equal(result.status, 0, result.stderr);
  result = run("missing-ref");
  assert.notEqual(result.status, 0, "missing history must fail closed");
  assert.notEqual(run("--typo").status, 0, "unknown modes must fail closed");
});

test("npm check and always-running hygiene enforce the guard before ci-ok", () => {
  const root = new URL("../", import.meta.url);
  const { scripts } = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
  assert.match(scripts.check, /^node scripts\/check-repo-files\.mjs(?:\s|$)/);
  assert.match(scripts.check, /node --test .*scripts\/check-repo-files\.test\.mjs(?:\s|$)/);
  const wf = load(readFileSync(new URL(".github/workflows/ci.yml", root), "utf8"));
  const hygiene = wf.jobs.hygiene;
  assert.equal(hygiene.if, undefined);
  const step = hygiene.steps.find((item) => item.run === "node scripts/check-repo-files.mjs --full");
  assert.ok(step, "docs-only PRs still need the file guard");
  assert.equal(step.if, undefined);
  assert.ok(!step["continue-on-error"]);
  assert.ok(hygiene.steps.some((item) => item.run?.includes("node --test ") && item.run.includes("scripts/check-repo-files.test.mjs")));
  assert.ok(wf.jobs["web-check"].steps.some((item) => item.run === "npm run check"));
  assert.ok(wf.jobs["ci-ok"].needs.includes("hygiene"));
});

for (const [file, rule] of [[".github/.env", "environment"], ["x/.ssh/id_rsa", "key-material"], [".config/x.pem", "key-material"], ["tools/.x", "private-tools"], ["ops/.x/a.yaml", "private-ops"], ["dir/.x/a.pdf", "personal-data-document"]]) {
  test(`hidden segments: ${file} is refused in both CLI modes`, (t) => {
    const { git, write, commit, run } = repository(t);
    write("safe.txt"); commit(); git("checkout", "-qb", "feature");
    write(file); commit();
    for (const mode of ["dev", "--full"]) {
      const result = run(mode);
      assert.equal(result.status, 1, result.stdout);
      assert.ok(result.stderr.includes(rule), result.stderr);
    }
  });
}

test("diff mode checks a regular file changed to a symlink", (t) => {
  const { dir, git, write, commit, run } = repository(t);
  write(".env.preexisting"); commit(); git("checkout", "-qb", "feature");
  rmSync(path.join(dir, ".env.preexisting"));
  symlinkSync("safe.txt", path.join(dir, ".env.preexisting")); commit();
  const result = run("dev");
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /environment/);
});

test("merge-queue diff mode uses the planner base without a local dev branch", (t) => {
  const { dir, git, write, commit } = repository(t);
  write("safe.txt"); commit();
  const base = git("rev-parse", "HEAD").trim();
  git("checkout", "-qb", "feature");
  git("branch", "-D", "dev");
  write(".env.refused"); commit();
  const result = spawnSync(process.execPath, [new URL("./check-repo-files.mjs", import.meta.url).pathname], {
    cwd: dir, encoding: "utf8", env: { ...process.env, CI_BASE_SHA: base, GITHUB_BASE_REF: "missing-ref" },
  });
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /\.env\.refused.*environment/);
  assert.doesNotMatch(result.stderr, /unknown revision|ambiguous argument/);
});

test("release dispatch with an empty planner base falls back to remote dev", (t) => {
  const { dir, git, write, commit } = repository(t);
  write("safe.txt"); commit();
  git("update-ref", "refs/remotes/origin/dev", "HEAD");
  git("checkout", "-qb", "feature");
  write(".env.refused"); commit();
  const result = spawnSync(process.execPath, [new URL("./check-repo-files.mjs", import.meta.url).pathname], {
    cwd: dir, encoding: "utf8", env: { ...process.env, CI_BASE_SHA: "", GITHUB_BASE_REF: "", GITHUB_EVENT_PATH: "", QUALITY_BASE: "" },
  });
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /\.env\.refused.*environment/);
});
