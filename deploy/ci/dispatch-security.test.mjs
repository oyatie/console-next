// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import yaml from 'js-yaml';

const root = resolve(process.env.PLATFORM_REPO_ROOT ?? '.');
const workflow = name => yaml.load(readFileSync(resolve(root, `.github/workflows/${name}.yml`), 'utf8'));
const gates = workflow('gates');
const promote = workflow('promote');
const sha = 'a'.repeat(40);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function ancestryStep() {
  const steps = gates.jobs.predicate.steps;
  const index = steps.findIndex(step => step.id === 'ancestry');
  assert.ok(index >= 0, 'Refuse non-dev candidates before checking out repository code');
  assert.ok(steps.slice(0, index).every(step => step.uses?.startsWith('step-security/harden-runner@')),
    'Ancestry must precede checkout, repository scripts, installs and cache setup');
  const step = steps[index];
  assert.ok(step.uses?.startsWith('actions/github-script@'));
  assert.equal(step.env.CANDIDATE_SHA, '${{ inputs.sha }}');
  assert.doesNotMatch(step.with.script, /\$\{\{/);
  return step;
}

async function checkAncestry(candidate, comparison) {
  const step = ancestryStep();
  let calls = 0;
  const github = {rest:{repos:{compareCommits:async params => {
    calls++;
    assert.deepEqual(params, {owner:'example', repo:'console', base:candidate, head:'dev'});
    if (comparison instanceof Error) throw comparison;
    return {data:comparison};
  }}}};
  const context = {repo:{owner:'example', repo:'console'}};
  await new AsyncFunction('github', 'context', 'process', step.with.script)(github, context,
    {env:{CANDIDATE_SHA:candidate}});
  assert.equal(calls, 1);
}

for (const status of ['ahead', 'identical']) test(`ancestry permits a dev ancestor (${status}) before checkout`, async () => {
  await checkAncestry(sha, {status, merge_base_commit:{sha}});
});

for (const [reason, candidate, comparison] of [
  ['unmerged fork', sha, {status:'diverged', merge_base_commit:{sha:'b'.repeat(40)}}],
  ['newer unmerged commit', sha, {status:'behind', merge_base_commit:{sha:'b'.repeat(40)}}],
  ['inconsistent merge base', sha, {status:'ahead', merge_base_commit:{sha:'b'.repeat(40)}}],
  ['unknown status', sha, {status:'unknown', merge_base_commit:{sha}}],
  ['branch name', 'dev', null],
  ['short SHA', 'abc123', null],
  ['zero SHA', '0'.repeat(40), null],
]) test(`GATES_NOT_ON_DEV: refuses ${reason} before checkout`, async () => {
  await assert.rejects(checkAncestry(candidate, comparison), /GATES_NOT_ON_DEV/);
});

test('ancestry lookup errors fail closed before checkout', async () => {
  await assert.rejects(checkAncestry(sha, new Error('commit not found')), /commit not found/);
});

test('gates and promotion install and execute only from the trusted dev checkout', () => {
  for (const job of [gates.jobs.predicate, promote.jobs.proof, promote.jobs.publish]) {
    const checkouts = job.steps.filter(step => step.uses?.startsWith('actions/checkout@'));
    assert.equal(checkouts.length, 1);
    assert.equal(checkouts[0].with.ref, 'dev');
    assert.equal(checkouts[0].with['fetch-depth'], 0);
    assert.equal(checkouts[0].with['persist-credentials'], false);
  }
  const predicate = gates.jobs.predicate.steps.find(step => step.id === 'predicate');
  assert.equal(predicate.env.CANDIDATE_SHA, '${{ inputs.sha }}');
});

test('dispatch path cannot restore or save npm or Actions caches', () => {
  for (const config of [gates, promote]) {
    assert.deepEqual(config.permissions, {});
    for (const job of Object.values(config.jobs)) {
      assert.ok(Object.values(job.permissions).every(permission => permission === 'read') || job === promote.jobs.publish);
      for (const step of job.steps ?? []) {
        assert.doesNotMatch(step.uses ?? '', /^actions\/cache(?:\/|@)/);
        if (step.uses?.startsWith('actions/setup-node@')) {
          assert.equal(step.with.cache, undefined, 'setup-node saves caches in its post step');
        }
      }
    }
  }
});
