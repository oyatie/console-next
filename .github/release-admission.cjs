// SPDX-License-Identifier: LicenseRef-Proprietary
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const policy = require('./release-admission-policy.json');

async function readCheckRuns(github, ref) {
  const [owner, repo] = policy.repository.split('/');
  return github.paginate('GET /repos/{owner}/{repo}/commits/{ref}/check-runs',
    { owner, repo, ref, per_page: 100, filter: 'all' });
}

function plan(from, to) {
  if (![from, to].every(sha => /^[a-f0-9]{40}$/.test(sha) && !/^0+$/.test(sha))) {
    throw new Error('Admission needs full nonzero base and candidate SHAs; use owner admission for the history root');
  }
  execFileSync('git', ['merge-base', '--is-ancestor', from, to]);
  const rows = execFileSync('git', ['rev-list', '--reverse', '--first-parent', '--parents', `${from}..${to}`],
    { encoding: 'utf8' }).trim().split('\n').filter(Boolean).map(row => row.split(' '));
  if (!rows.length || rows.length > 256 || rows.some(row => row.length !== 3)) {
    throw new Error('Every dev transition must be a two-parent PR merge (maximum 256 per run)');
  }
  return { merge: rows.map(row => row[0]) };
}

async function collect(github, merge) {
  const [owner, repo] = policy.repository.split('/');
  const params = { owner, repo };
  const list = (route, extra) => github.paginate(route, { ...params, per_page: 100, ...extra });
  const { data: repository } = await github.rest.repos.get(params);
  if (repository.id !== policy.repository_id) throw new Error('Repository identity changed');
  const { data: commit } = await github.rest.repos.getCommit({ ...params, ref: merge });
  if (commit.sha !== merge || commit.parents.length !== 2) throw new Error('Direct push is not a PR merge');
  const [base, head] = commit.parents.map(parent => parent.sha);
  const prs = (await list('GET /repos/{owner}/{repo}/commits/{commit_sha}/pulls', { commit_sha: merge }))
    .filter(pr => pr.merged_at && pr.merge_commit_sha === merge);
  if (prs.length !== 1) throw new Error('Expected exactly one merged PR record');
  const [pr] = prs;
  if (`refs/heads/${pr.base.ref}` !== policy.ref || pr.base.repo.id !== policy.repository_id || pr.head.sha !== head) {
    throw new Error('Mismatched merged PR record');
  }
  const mergedAt = Date.parse(pr.merged_at);
  if (!Number.isFinite(mergedAt)) throw new Error('Invalid PR merge time');
  const { data: ruleset } = await github.request('GET /repos/{owner}/{repo}/rulesets/{ruleset_id}',
    { ...params, ruleset_id: policy.ruleset_id });
  const rules = await list('GET /repos/{owner}/{repo}/rules/branches/{branch}',
    { branch: policy.ref.replace('refs/heads/', '') });
  if (ruleset.id !== policy.ruleset_id || ruleset.enforcement !== 'active' ||
      !['pull_request', 'required_status_checks'].every(kind =>
        rules.some(rule => rule.ruleset_id === policy.ruleset_id && rule.type === kind))) {
    throw new Error('Required PR/check rules are inactive or do not apply to dev');
  }
  const required = rules.filter(rule => rule.type === 'required_status_checks')
    .flatMap(rule => rule.parameters.required_status_checks).map(check => ({
      context: check.context, integration_id: check.integration_id ?? policy.check_app_id,
    }));
  if (!required.length || !policy.required_checks.every(expected =>
    required.some(check => check.context === expected.context && check.integration_id === expected.integration_id))) {
    throw new Error('Required checks were weakened; update the admission policy with CI changes');
  }
  const runs = (await readCheckRuns(github, head))
    .filter(run => Date.parse(run.started_at) < mergedAt).sort((a, b) => b.id - a.id);
  const checks = required.map(check => runs.find(run => run.name === check.context &&
    run.app.id === check.integration_id));
  if (!checks.every(run => run && Number.isInteger(run.id) && run.id > 0 && run.head_sha === head &&
      run.status === 'completed' && run.conclusion === 'success' && Date.parse(run.completed_at) < mergedAt)) {
    throw new Error('Required PR-head checks did not pass before merge');
  }
  return {
    repository: policy.repository, repository_id: policy.repository_id, ref: policy.ref,
    pr: pr.number, merge_sha: pr.merge_commit_sha, after_sha: commit.sha, head_sha: head, base_sha: base,
    merged_at: pr.merged_at, ruleset_id: policy.ruleset_id,
    ruleset: { id: ruleset.id, enforcement: ruleset.enforcement }, required_checks: required,
    check_runs: checks.map(run => ({ id: run.id, name: run.name, head_sha: run.head_sha,
      app_id: run.app.id, status: run.status, conclusion: run.conclusion, completed_at: run.completed_at })),
  };
}

function write(record) {
  fs.writeFileSync('dev-merge', `${record.merge_sha}\n`);
  fs.writeFileSync('pr-admission.json', JSON.stringify(record));
}

module.exports = { plan, collect, write, readCheckRuns };
