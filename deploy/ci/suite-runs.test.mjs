// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { suiteRunsFixture } from './fixtures/suite-runs.mjs';

const root = resolve(process.env.PLATFORM_REPO_ROOT ?? '.');
const {collectSuiteRuns} = await import(pathToFileURL(resolve(root, 'deploy/ci/suite-runs.mjs')));
const sha = 'a'.repeat(40);
const candidate = {sha, repository:'example/console'};
const databaseJob = fixture => fixture.testsJob(fixture.database);
const suiteGate = fixture => collectSuiteRuns(fixture.github, 'production', candidate);

for (const [reason, change, refused] of [
  ['a missing run', fixture => fixture.runs['db-tests.yml'].pop(), 'db-tests.yml (missing candidate run)'],
  ['another SHA', fixture => { fixture.database.head_sha = 'b'.repeat(40); }, 'db-tests.yml (missing candidate run)'],
  ['another branch', fixture => { fixture.database.head_branch = 'main'; }, 'db-tests.yml (missing candidate run)'],
  ['a partial live browser dispatch', fixture => {
    Object.assign(fixture.liveBrowser, {event:'workflow_dispatch', path:'.github/workflows/e2e-live-partial.yml'});
  }, 'e2e-live.yml (missing candidate run)'],
  ['a fork run', fixture => { fixture.database.head_repository.full_name = 'other/console'; }, 'db-tests.yml (missing candidate run)'],
  ...['pull_request', 'merge_group'].map(event => [`a lone ${event} run`,
    fixture => { fixture.database.event = event; }, 'db-tests.yml (missing candidate run)']),
  ['a red push followed by a green pull request', fixture => {
    fixture.database.conclusion = 'failure';
    fixture.addRun('db-tests.yml', 'pull_request');
  }, 'db-tests.yml (failure)'],
  ['an unfinished run', fixture => { fixture.liveBrowser.status = 'in_progress'; }, 'e2e-live.yml (in_progress)'],
  ['a missing run conclusion', fixture => { fixture.database.conclusion = null; }, 'db-tests.yml (missing conclusion)'],
  ['a newer failed run', fixture => { fixture.addRun('e2e-live.yml', 'schedule').conclusion = 'failure'; }, 'e2e-live.yml (failure)'],
  ['an older failed run followed by green', fixture => {
    fixture.liveBrowser.conclusion = 'failure';
    fixture.addRun('e2e-live.yml', 'schedule');
  }, 'e2e-live.yml (failure)'],
  ['an older cancelled run followed by green', fixture => {
    fixture.routeLoad.conclusion = 'cancelled';
    fixture.addRun('route-load.yml', 'schedule');
  }, 'route-load.yml (cancelled)'],
  ['a green nightly after a dispatch skipped Firefox', fixture => {
    fixture.liveBrowser.event = 'workflow_dispatch';
    Object.assign(fixture.testsJob(fixture.liveBrowser), {name:'firefox-states', conclusion:'skipped'});
    fixture.addRun('e2e-live.yml', 'schedule');
  }, 'e2e-live.yml (job firefox-states: skipped)'],
  ['a successful rerun of a failed job', fixture => {
    fixture.liveBrowser.run_attempt = 2;
    const job = fixture.testsJob(fixture.liveBrowser);
    fixture.jobs.get(fixture.liveBrowser.id).push({...job, run_attempt:2});
    job.conclusion = 'failure';
  }, 'e2e-live.yml (expected first attempt)'],
  ['an unknown run attempt', fixture => { delete fixture.database.run_attempt; }, 'db-tests.yml (expected first attempt)'],
  ['an invalid run ID', fixture => { fixture.database.id = 0; }, 'db-tests.yml (invalid run ID)'],
  ['a noninteger run ID', fixture => { fixture.database.id = 1.5; }, 'db-tests.yml (invalid run ID)'],
  ['an empty job list', fixture => { fixture.jobs.get(fixture.routeLoad.id).length = 0; }, 'route-load.yml (missing jobs)'],
  ['another job SHA', fixture => { databaseJob(fixture).head_sha = 'b'.repeat(40); }, 'db-tests.yml (job identity mismatch)'],
  ['another job run', fixture => { databaseJob(fixture).run_id = fixture.routeLoad.id; }, 'db-tests.yml (job identity mismatch)'],
  ...[undefined, 0, 2].map(attempt => [`a job with attempt ${attempt}`,
    fixture => { databaseJob(fixture).run_attempt = attempt; }, 'db-tests.yml (job identity mismatch)']),
  ['an unnamed job', fixture => { databaseJob(fixture).name = ''; }, 'db-tests.yml (job identity mismatch)'],
  ['a nonstring job name', fixture => { databaseJob(fixture).name = 1; }, 'db-tests.yml (job identity mismatch)'],
  ['a run without status', fixture => { delete fixture.database.status; }, 'db-tests.yml (unfinished)'],
  ['a job without status', fixture => { delete databaseJob(fixture).status; }, 'db-tests.yml (job tests: unfinished)'],
  ['an unfinished push reporting cancellation', fixture => {
    Object.assign(fixture.database, {status:'in_progress', conclusion:'cancelled'});
    fixture.jobs.set(fixture.database.id, []);
  }, 'db-tests.yml (in_progress)'],
  ['a failed push with no jobs', fixture => {
    fixture.database.conclusion = 'failure';
    fixture.jobs.set(fixture.database.id, []);
  }, 'db-tests.yml (failure)'],
  ['a cancelled push with jobs', fixture => { fixture.database.conclusion = 'cancelled'; }, 'db-tests.yml (cancelled)'],
  ...['push', 'schedule', 'workflow_dispatch'].map(event => [`a cancelled ${event} with no jobs`, fixture => {
    Object.assign(fixture.database, {event, conclusion:'cancelled'});
    fixture.jobs.set(fixture.database.id, []);
  }, `db-tests.yml (${event === 'push' ? 'missing candidate run' : 'cancelled'})`]),
  ['an unfinished job', fixture => { databaseJob(fixture).status = 'in_progress'; }, 'db-tests.yml (job tests: in_progress)'],
  ...['failure', 'skipped', 'cancelled', null].map(conclusion => [`a job with conclusion ${conclusion}`,
    fixture => { databaseJob(fixture).conclusion = conclusion; }, `db-tests.yml (job tests: ${conclusion ?? 'missing conclusion'})`]),
  ['missing and red suites together', fixture => {
    fixture.runs['db-tests.yml'].pop();
    fixture.testsJob(fixture.liveBrowser).conclusion = 'cancelled';
    fixture.routeLoad.conclusion = 'failure';
  }, 'db-tests.yml (missing candidate run), e2e-live.yml (job tests: cancelled), route-load.yml (failure)'],
]) test(`production suite gate refuses ${reason}`, async () => {
  const fixture = suiteRunsFixture(sha, candidate.repository);
  change(fixture);
  const {refusals} = await suiteGate(fixture);
  assert.deepEqual(refusals, refused.split(', '));
});

test('a green schedule qualifies beside a push cancelled before its jobs started', async () => {
  const fixture = suiteRunsFixture(sha, candidate.repository);
  fixture.database.conclusion = 'cancelled';
  fixture.jobs.set(fixture.database.id, []);
  const scheduled = fixture.addRun('db-tests.yml', 'schedule');
  const {runs, refusals} = await suiteGate(fixture);
  assert.deepEqual(refusals, []);
  assert.deepEqual(runs.map(run => run.id), [scheduled.id, fixture.liveBrowser.id, fixture.routeLoad.id]);
});

test('production suite gate admits first-attempt successes and ignores a newer fork run', async () => {
  const fixture = suiteRunsFixture(sha, candidate.repository);
  fixture.addRun('db-tests.yml', 'push').head_repository.full_name = 'other/console';
  assert.deepEqual(await suiteGate(fixture), {refusals:[], runs:[fixture.database, fixture.liveBrowser, fixture.routeLoad]
    .map(({id, path, run_attempt, html_url}) => ({workflow:path.split('/').at(-1), id, run_attempt, html_url}))});
  for (const {route, params} of fixture.requests) {
    assert.equal(params.owner + '/' + params.repo, candidate.repository);
    assert.equal(params.per_page, 100);
    if (params.workflow_id) {
      assert.equal(route, 'GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs');
      assert.equal(params.branch, 'dev');
      assert.equal(params.head_sha, sha);
    } else {
      assert.equal(route, 'GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}/jobs');
      assert.equal(params.attempt_number, 1);
    }
  }
});

for (const status of [401, 403, 404, 429, 500]) {
  for (const endpoint of ['runs', 'jobs']) test(`suite ${endpoint} API propagates HTTP ${status} unchanged`, async () => {
    const fixture = suiteRunsFixture(sha, candidate.repository);
    const error = Object.assign(new Error('suite API unavailable', {cause:new Error('upstream error')}), {status});
    const {paginate} = fixture.github;
    fixture.github.paginate = async (route, params) => {
      if (route.endsWith('/' + endpoint)) throw error;
      return paginate(route, params);
    };
    await assert.rejects(() => suiteGate(fixture), actual => actual === error);
  });
}

test('production suite gate propagates a programming error unchanged', async () => {
  const error = new TypeError('invalid jobs response');
  const github = {paginate:async () => { throw error; }};
  await assert.rejects(collectSuiteRuns(github, 'production', candidate), e => e === error);
});

test('suite gate fails for an environment without an explicit policy', async () => {
  await assert.rejects(() => collectSuiteRuns({}, 'candidate', candidate),
    {name:'AssertionError', message:/^PROMOTE_ENVIRONMENT: candidate has no suite policy$/});
});
