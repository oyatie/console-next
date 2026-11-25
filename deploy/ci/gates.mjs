// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { matchesGlob } from 'node:path';
import policy from '../../.github/release-admission-policy.json' with {type:'json'};
import gatesPolicy from '../gates.json' with {type:'json'};
import admission from '../../.github/release-admission.cjs';

// Gate names are the console-gates/v1 host contract, not GitHub check names.
const required = ['code-gates', 'api-compat', 'sbom', 'scan', 'smoke'];

export function classifyBake(changedPaths, longBakePaths) {
  const valid = paths => Array.isArray(paths) && paths.every(path =>
    typeof path === 'string' && path.length > 0 && !path.startsWith('/') && !path.split('/').includes('..'));
  assert.ok(valid(changedPaths), 'Release gates need the complete change set');
  assert.ok(valid(longBakePaths) && longBakePaths.length > 0, 'Release gates need the release bake path policy');
  return changedPaths.some(path => longBakePaths.some(pattern => matchesGlob(path, pattern))) ? 'long' : 'normal';
}

// The collector supplies check runs grouped by gate; smoke needs both native architecture jobs.
export function buildPredicate({sha, gateChecks, changedPaths, longBakePaths, runUrl}) {
  assert.match(sha, /^(?!0{40}$)[a-f0-9]{40}$/, 'Release gates need a full nonzero candidate SHA');
  const url = new URL(runUrl);
  assert.ok(url.origin === 'https://github.com' && !url.search && !url.hash &&
    new RegExp(`^/${policy.repository}/actions/runs/[1-9][0-9]*(/attempts/[1-9][0-9]*)?$`).test(url.pathname),
  'Release gates need a workflow run URL from the admitted repository');
  const gates = required.map(name => {
    const checks = gateChecks && Object.hasOwn(gateChecks, name) ? gateChecks[name] : undefined;
    const pass = Array.isArray(checks) && checks.length === (name === 'smoke' ? 2 : 1) &&
      new Set(checks.map(check => check?.id)).size === checks.length && checks.every(check =>
        Number.isSafeInteger(check?.id) && check.id > 0 && check.head_sha === sha &&
        check.app?.id === policy.check_app_id && check.status === 'completed' && check.conclusion === 'success');
    return {name, result:pass ? 'pass' : 'fail'};
  });
  return {
    result:gates.every(gate => gate.result === 'pass') ? 'pass' : 'fail',
    predicate:{
      inputs:{backend:sha, web:sha}, gates,
      runner:{kind:'gha', url:runUrl}, approver:null,
      bake:classifyBake(changedPaths, longBakePaths),
    },
  };
}

export const suiteEvents = ['push', 'schedule', 'workflow_dispatch'];

function devRuns(github, params, workflow, sha, event) {
  return github.paginate('GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs',
    {...params, workflow_id:workflow, head_sha:sha, branch:'dev', ...(event && {event})});
}

function isCandidateRun(run, workflow, sha) {
  return run?.head_sha === sha && run.head_branch === 'dev' && run.path === `.github/workflows/${workflow}`;
}

export function attemptJobs(github, params, runId, attempt) {
  return github.paginate('GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}/jobs',
    {...params, run_id:runId, attempt_number:attempt});
}

function unsuccessful({status, conclusion}) {
  if (status !== 'completed') return status || 'unfinished';
  return conclusion === 'success' ? null : conclusion || 'missing conclusion';
}

async function suiteEvidence(github, params, workflow, sha) {
  const history = await devRuns(github, params, workflow, sha);
  const candidates = history.filter(run => isCandidateRun(run, workflow, sha) &&
    run.head_repository?.full_name === `${params.owner}/${params.repo}` &&
    suiteEvents.includes(run.event));
  const runs = [];
  for (const run of candidates) {
    if (!Number.isSafeInteger(run.id) || run.id < 1) return {refusal:'invalid run ID'};
    if (run.run_attempt !== 1) return {refusal:'expected first attempt'};
    const reason = unsuccessful(run);
    if (reason) {
      // A queued run can lose its concurrency slot before it exercises the candidate.
      if (run.status === 'completed' && run.conclusion === 'cancelled' &&
        !(await attemptJobs(github, params, run.id, 1)).length) continue;
      return {refusal:reason};
    }
    const jobs = await attemptJobs(github, params, run.id, 1);
    if (!jobs.length) return {refusal:'missing jobs'};
    for (const job of jobs) {
      if (job.run_id !== run.id || job.head_sha !== sha || job.run_attempt !== 1 ||
        typeof job.name !== 'string' || !job.name) return {refusal:'job identity mismatch'};
      const jobReason = unsuccessful(job);
      if (jobReason) return {refusal:`job ${job.name}: ${jobReason}`};
    }
    const {id, run_attempt, html_url} = run;
    runs.push({workflow, id, run_attempt, html_url});
  }
  return runs.length ? {runs} : {refusal:'missing candidate run'};
}

export async function collectSuiteRuns(github, environment, {sha, repository}) {
  const suites = gatesPolicy.environmentSuites?.[environment];
  assert.ok(Array.isArray(suites), `PROMOTE_ENVIRONMENT: ${environment} has no suite policy`);
  const [owner, repo] = repository.split('/');
  const runs = [];
  const refusals = [];
  for (const workflow of suites) {
    const evidence = await suiteEvidence(github, {owner, repo, per_page:100}, workflow, sha);
    if (evidence.refusal) refusals.push(`${workflow} (${evidence.refusal})`);
    else runs.push(...evidence.runs);
  }
  return {runs, refusals};
}

export async function collectChecks(github, sha) {
  assert.match(sha, /^(?!0{40}$)[a-f0-9]{40}$/);
  const [owner, repo] = policy.repository.split('/');
  const params = {owner, repo, per_page:100};
  const checks = await admission.readCheckRuns(github, sha);
  const workflows = new Map();
  for (const {workflow} of Object.values(gatesPolicy.checks).flat()) {
    if (workflows.has(workflow)) continue;
    const runs = await devRuns(github, params, workflow, sha, 'push').catch(error => {
      if (error.status === 404) return [];
      throw error;
    });
    const run = runs.sort((a, b) => b.id - a.id)[0];
    const jobs = isCandidateRun(run, workflow, sha) && run.event === 'push'
      ? await attemptJobs(github, params, run.id, run.run_attempt) : [];
    workflows.set(workflow, {run, jobs});
  }
  return Object.fromEntries(Object.entries(gatesPolicy.checks).map(([gate, definitions]) => [gate, definitions.flatMap(def => {
    const {run, jobs} = workflows.get(def.workflow);
    const matching = jobs.filter(job => job.name === def.job);
    if (matching.length !== 1) return [];
    const [job] = matching;
    const evidence = checks.filter(check => job.check_run_url ===
      `https://api.github.com/repos/${policy.repository}/check-runs/${check.id}` && check.check_suite?.id === run.check_suite_id);
    const steps = def.step ? job.steps.filter(step => step.name === def.step) : [];
    const success = job.head_sha === sha && job.status === 'completed' && job.conclusion === 'success' &&
      (!def.step || steps.length === 1 && steps[0].status === 'completed' && steps[0].conclusion === 'success');
    return evidence.map(check => ({...check, conclusion:success ? check.conclusion : 'failure'}));
  })]));
}

export async function emit(github, core, sha, base, runUrl) {
  const changedPaths = execFileSync('git', ['diff', '--no-renames', '--name-only', '-z', `${base}..${sha}`], {encoding:'utf8'}).split('\0').filter(Boolean);
  const record = buildPredicate({sha, runUrl, changedPaths, longBakePaths:gatesPolicy.longBakePaths,
    gateChecks:await collectChecks(github, sha)});
  writeFileSync('console-gates.json', JSON.stringify(record.predicate, null, 2) + '\n');
  // github-script overwrites the `result` output with the script's return value.
  core.setOutput('verdict', record.result);
}
