// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./check-commit-subjects.mjs", import.meta.url));
const identity = {
  GIT_AUTHOR_NAME: "Jason Lee", GIT_COMMITTER_NAME: "Jason Lee",
  GIT_AUTHOR_EMAIL: "56489493+jason931225@users.noreply.github.com",
  GIT_COMMITTER_EMAIL: "56489493+jason931225@users.noreply.github.com",
};
function repository(t) {
  const cwd = mkdtempSync(path.join(tmpdir(), "commit-subjects-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", input: "", env: { ...process.env, ...identity } }).trim();
  git("init", "--quiet");
  const tree = git("mktree");
  const commit = (message, ...parents) => git("commit-tree", tree, ...parents.flatMap((p) => ["-p", p]), "-m", message);
  const check = (base, head, event = "pull_request") => spawnSync(process.execPath, [script, base, head, event], { cwd, encoding: "utf8" });
  return { commit, check };
}

test("refuses a planted non-conforming subject even when the head is valid", (t) => {
  const { commit, check } = repository(t);
  const base = commit("historical subject outside the range");
  const bad = commit("planted non-conforming subject", base);
  const head = commit("fix: a valid head cannot hide an earlier commit", bad);
  const result = check(base, head);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.ok(result.stderr.includes(bad), result.stderr);
  assert.match(result.stderr, /planted non-conforming subject/);
});

// Verbatim messages from https://www.conventionalcommits.org/en/v1.0.0/#examples.
// Footer fixtures are strings only; no attribution trailers are written to Git.
const examples = [
  "feat: allow provided config object to extend other configs\n\nBREAKING CHANGE: `extends` key in config file is now used for extending other config files",
  "feat!: send an email to the customer when a product is shipped",
  "feat(api)!: send an email to the customer when a product is shipped",
  "feat!: drop support for Node 6\n\nBREAKING CHANGE: use JavaScript features not available in Node 6.",
  "docs: correct spelling of CHANGELOG",
  "feat(lang): add Polish language",
  "fix: prevent racing of requests\n\nIntroduce a request id and a reference to latest request. Dismiss\nincoming responses other than from latest request.\n\nRemove timeouts which were used to mitigate the racing issue but are\nobsolete now.\n\nReviewed-by: Z\nRefs: #123",
];
for (const message of examples) test(`spec example: ${message.split("\n")[0]}`, async () => {
  const { isConventionalSubject } = await import("./check-commit-subjects.mjs");
  assert.equal(isConventionalSubject(message.split("\n")[0]), true);
});

for (const subject of [
  ...["build", "chore", "ci", "docs", "feat", "fix", "perf", "refactor", "revert", "style", "test"].map((type) => `${type}: valid description`),
  "build(deps-dev): refresh tooling", "FIX(API-V2)!: change a contract", 'Revert "feat: a prior change"',
  'Revert "old non-conforming subject"',
  "fix(auth/session): 세션 오류 수정", "revert: undo the prior change", "feat: support a colon: in the description",
]) test(`accepts ${subject}`, async () => {
  const { isConventionalSubject } = await import("./check-commit-subjects.mjs");
  assert.equal(isConventionalSubject(subject), true);
});

for (const subject of [
  "", "update dependencies", "feat:missing space", "feat:", "feat: ", "feat:   ", "feat:\tmissing space",
  ": missing type", " feat: leading whitespace", "feat : misplaced space", "feat(): empty scope",
  "feat( ): blank scope", "feat(api: missing parenthesis", "feat(api)): extra parenthesis",
  "feat!!: duplicate marker", "feat!(api): misplaced marker", "feat(api)! : misplaced space",
  "BREAKING CHANGE: footer is not a subject", "WIP: unfinished change", "custom: a project-specific type", 'Revert ""',
  "Merge pull request #1 from example/feature", "fixup! feat: incomplete autosquash",
]) test(`refuses ${JSON.stringify(subject)}`, async () => {
  const { isConventionalSubject } = await import("./check-commit-subjects.mjs");
  assert.equal(isConventionalSubject(subject), false);
});

test("checks the PR head range without auditing existing base history or the checkout", (t) => {
  const { commit, check } = repository(t);
  const old = commit("old history");
  const head = commit("feat(auth-ui)!: 로그인 개선\n\nBREAKING CHANGE: session contract", old);
  const base = commit("unrelated new base history", old);
  const result = check(base, head);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /1 commit\(s\) checked/);
});

test("ordinary PR merges are exempt, regardless of their subject", (t) => {
  const { commit, check } = repository(t);
  const base = commit("old history");
  const left = commit("feat: left", base);
  const right = commit("fix: right", base);
  const merge = commit("Merge pull request #1 from example/feature", left, right);
  const result = check(base, merge);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /2 commit\(s\) checked, 1 merge\(s\) exempt/);
  assert.equal(check(base, commit("chore: merge feature", left, right)).status, 0);
});

test("Git revert subjects pass in PRs and merge groups", (t) => {
  const { commit, check } = repository(t);
  const base = commit("old history");
  const revert = commit('Revert "old non-conforming subject"', base);
  for (const event of ["pull_request", "merge_group"]) {
    const result = check(base, revert, event);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /1 commit\(s\) checked/);
  }
});

test("merge groups exempt the queue's first-parent merge spine, including earlier entries", (t) => {
  const { commit, check } = repository(t);
  const base = commit("old history");
  const first = commit("feat: first", base);
  const second = commit("fix: second", base);
  const queued = commit("Merge first queued pull request", base, first);
  const head = commit("Merge second queued pull request", queued, second);
  const result = check(base, head, "merge_group");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /2 commit\(s\) checked, 2 merge\(s\) exempt/);
});

test("merge groups exempt side-branch merges while refusing bad non-merge commits", (t) => {
  const { commit, check } = repository(t);
  const base = commit("old history");
  const bad = commit("Merge this is not a merge commit", base);
  const valid = commit("feat: valid", base);
  const prMerge = commit("Merge a user-created branch", valid, bad);
  const head = commit("Merge queued pull request", base, prMerge);
  const result = check(base, head, "merge_group");
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes(bad), result.stderr);
  assert.ok(!result.stderr.includes(prMerge), result.stderr);
  assert.ok(!result.stderr.includes(head), result.stderr);
  assert.match(result.stdout, /2 commit\(s\) checked, 2 merge\(s\) exempt/);
  const validMerge = commit("Merge a user-created branch", valid, base);
  const validHead = commit("Merge queued pull request", base, validMerge);
  assert.equal(check(base, validHead, "merge_group").status, 0);
});

test("a queue rebase or squash gets no merge exemption", (t) => {
  const { commit, check } = repository(t);
  const base = commit("old history");
  assert.equal(check(base, commit("feat: squash", base), "merge_group").status, 0);
  assert.equal(check(base, commit("unconventional squash", base), "merge_group").status, 1);
});

test("empty ranges fail with a range diagnostic for both events", (t) => {
  const { commit, check } = repository(t);
  const base = commit("old history");
  for (const event of ["pull_request", "merge_group"]) {
    const result = check(base, base, event);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /empty range; verify the base and head revisions/);
    assert.equal(result.stdout, "");
  }
});

test("missing revisions and unsupported events fail closed", (t) => {
  const { commit, check } = repository(t);
  const base = commit("old history");
  const head = commit("feat: valid", base);
  for (const args of [[base, "missing"], ["--all", head], [base, head, "push"]]) {
    const result = check(...args);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.ok(result.stderr.length > 0);
  }
});

test("merge group base must be on the generated first-parent chain", (t) => {
  const { commit, check } = repository(t);
  const old = commit("old history");
  const base = commit("chore: base", old);
  const side = commit("feat: side", old);
  const reversed = commit("Merge in the wrong direction", side, base);
  const result = check(base, reversed, "merge_group");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /first-parent/);
});
