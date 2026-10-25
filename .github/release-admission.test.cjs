// SPDX-License-Identifier: LicenseRef-Proprietary
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { collect, plan } = require('./release-admission.cjs');
const policy = require('./release-admission-policy.json');
const merge = 'a'.repeat(40), base = 'b'.repeat(40), head = 'c'.repeat(40);

function fixture() {
  const data = {
    commit: { sha: merge, parents: [{ sha: base }, { sha: head }] },
    prs: [{ number: 1, merged_at: '2026-10-23T01:00:00Z', merge_commit_sha: merge,
      base: { ref: 'dev', repo: { id: policy.repository_id } }, head: { sha: head } }],
    ruleset: { id: policy.ruleset_id, enforcement: 'active' },
    rules: [{ type: 'pull_request', ruleset_id: policy.ruleset_id },
      { type: 'required_status_checks', ruleset_id: policy.ruleset_id,
        parameters: { required_status_checks: structuredClone(policy.required_checks) } }],
    checks: policy.required_checks.map((check, id) => ({ id: id + 1, name: check.context,
      app: { id: check.integration_id }, head_sha: head, status: 'completed', conclusion: 'success',
      started_at: '2026-10-23T00:00:00Z', completed_at: '2026-10-23T00:59:59Z' })),
  };
  const github = {
    rest: { repos: { get: async () => ({ data: { id: policy.repository_id } }),
      getCommit: async () => ({ data: data.commit }) } },
    paginate: async (route, params) => {
      if (route.endsWith('/pulls')) return data.prs;
      if (route.endsWith('/rules/branches/{branch}')) {
        assert.equal(params.branch, 'dev');
        return data.rules;
      }
      if (route.endsWith('/check-runs')) {
        assert.equal(params.ref, head);
        assert.equal(params.filter, 'all');
        return data.checks;
      }
      throw new Error(`Unexpected route ${route}`);
    },
    request: async route => {
      assert.equal(route, 'GET /repos/{owner}/{repo}/rulesets/{ruleset_id}');
      return { data: data.ruleset };
    },
  };
  return { github, data };
}

test('attests one merged PR and its required head checks before merge using read-only token APIs', async () => {
  const { github } = fixture();
  const record = await collect(github, merge);
  assert.equal(record.merge_sha, merge);
  assert.equal(record.after_sha, merge);
  assert.equal(record.head_sha, head);
  assert.equal(record.base_sha, base);
  assert.equal(record.ruleset.enforcement, 'active');
  assert.deepEqual(record.required_checks, policy.required_checks);
  assert.equal(record.check_runs.length, policy.required_checks.length);
});

for (const [name, mutate] of [
  ['evaluate ruleset', data => { data.ruleset.enforcement = 'evaluate'; }],
  ['wrong after sha', data => { data.commit.sha = head; }],
  ['missing PR', data => { data.prs = []; }],
  ['ambiguous merged PRs', data => { data.prs.push(structuredClone(data.prs[0])); }],
  ['unmerged PR', data => { data.prs[0].merged_at = null; }],
  ['wrong merge SHA', data => { data.prs[0].merge_commit_sha = head; }],
  ['wrong PR head', data => { data.prs[0].head.sha = base; }],
  ['wrong PR target', data => { data.prs[0].base.ref = 'other'; }],
  ['wrong PR repository', data => { data.prs[0].base.repo.id = 1; }],
  ['non-merge transition', data => { data.commit.parents.pop(); }],
  ['failed required check', data => { data.checks[0].conclusion = 'failure'; }],
  ['skipped required check', data => { data.checks[0].conclusion = 'skipped'; }],
  ['pending check', data => { data.checks[0].status = 'in_progress'; }],
  ['wrong check SHA', data => { data.checks[0].head_sha = merge; }],
  ['wrong check app', data => { data.checks[0].app.id = 1; }],
  ['missing check', data => { data.checks = []; }],
  ['check completed at merge', data => { data.checks[0].completed_at = data.prs[0].merged_at; }],
  ['check completed after merge', data => { data.checks[0].completed_at = '2026-10-23T01:00:01Z'; }],
  ['missing completion time', data => { data.checks[0].completed_at = null; }],
  ['invalid merge time', data => { data.prs[0].merged_at = 'invalid'; }],
  ['wrong active ruleset', data => { data.ruleset.id = 1; }],
  ['inapplicable PR rule', data => { data.rules[0].ruleset_id = 1; }],
  ['inapplicable check rule', data => { data.rules[1].ruleset_id = 1; }],
  ['missing branch rules', data => { data.rules = []; }],
  ['required checks removed', data => { data.rules[1].parameters.required_status_checks = []; }],
  ['required checks weakened', data => { data.rules[1].parameters.required_status_checks.pop(); }],
]) test(`refuses ${name}`, async () => {
  const { github, data } = fixture();
  mutate(data);
  await assert.rejects(collect(github, merge));
});

test('a later rerun cannot replace a failed head check at merge', async () => {
  const { github, data } = fixture();
  data.checks.push({ ...data.checks[0], id: 999, started_at: '2026-10-23T01:01:00Z',
    completed_at: '2026-10-23T01:02:00Z' });
  data.checks[0].conclusion = 'failure';
  await assert.rejects(collect(github, merge));
});

test('a later rerun does not invalidate successful evidence at merge', async () => {
  const { github, data } = fixture();
  data.checks.push({ ...data.checks[0], id: 999, conclusion: 'failure',
    started_at: '2026-10-23T01:01:00Z', completed_at: '2026-10-23T01:02:00Z' });
  const record = await collect(github, merge);
  assert.equal(record.check_runs[0].id, data.checks[0].id);
});

test('checks required by additional active rulesets must also pass', async () => {
  const { github, data } = fixture();
  data.rules.push({ type: 'required_status_checks', ruleset_id: 2,
    parameters: { required_status_checks: [{ context: 'additional', integration_id: policy.check_app_id }] } });
  await assert.rejects(collect(github, merge));
});

test('plans PR merges and refuses direct pushes', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-admission-'));
  const previous = process.cwd();
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1' } }).trim();
  try {
    process.chdir(folder);
    git('init', '-b', 'dev');
    git('config', 'user.name', 'Jason Lee');
    git('config', 'user.email', '56489493+jason931225@users.noreply.github.com');
    git('config', 'commit.gpgsign', 'false');
    git('commit', '--allow-empty', '-m', 'test: root');
    const root = git('rev-parse', 'HEAD');
    git('switch', '-c', 'feature');
    git('commit', '--allow-empty', '-m', 'test: feature');
    git('switch', 'dev');
    git('merge', '--no-ff', 'feature', '-m', 'test: merge');
    const merged = git('rev-parse', 'HEAD');
    assert.deepEqual(plan(root, merged), { merge: [merged] });
    git('commit', '--allow-empty', '-m', 'test: direct push');
    const direct = git('rev-parse', 'HEAD');
    assert.throws(() => plan(root, direct), /two-parent PR merge/);
    assert.throws(() => plan('0'.repeat(40), direct), /nonzero/);
  } finally {
    process.chdir(previous);
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
