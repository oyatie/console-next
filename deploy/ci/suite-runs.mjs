// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from 'node:assert/strict';
import gatesPolicy from '../gates.json' with {type:'json'};

export const suiteEvents = ['push', 'schedule', 'workflow_dispatch'];

export function devRuns(github, params, workflow, sha, event) {
  return github.paginate('GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs',
    {...params, workflow_id:workflow, head_sha:sha, branch:'dev', ...(event && {event})});
}

export function isCandidateRun(run, workflow, sha) {
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
      // A queued dev push can lose its concurrency slot before it exercises the candidate.
      if (run.event === 'push' && run.status === 'completed' && run.conclusion === 'cancelled' &&
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
