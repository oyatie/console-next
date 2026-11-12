// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import yaml from 'js-yaml';

// Discover commands, including shared step aliases, rather than keeping an opt-in job list.
const heavy = /\bcargo (?:build|test|clippy|install)\b|\bnpm (?:ci|run (?:check|build|test))\b|\bplaywright (?:test|install)\b|states-shards\.mjs run\b|backend-tests\.mjs(?! --collect)\b|\bbuildx build\b|\bdocker (?:build|load|pull)\b|\bkind create cluster\b|\bgrype\b|bash deploy\/ci\/exit-test\.sh|\btar (?:--null|-[cx])/;
const heavyAction = step => /github\/codeql-action\/(?:init|analyze)@/.test(step.uses ?? '');
const directory = new URL('../.github/workflows/', import.meta.url);
const workflows = readdirSync(directory).filter(file => file.endsWith('.yml')).map(file => [file, yaml.load(readFileSync(new URL(file, directory), 'utf8'))]);

function check(workflow, id, job) {
  const steps = job.steps;
  const heavySteps = steps.filter(step => heavy.test(step.run ?? ''));
  const minimum = job.env?.RUNNER_DISK_MIN_BYTES ?? workflow.env?.RUNNER_DISK_MIN_BYTES;
  assert.match(minimum ?? '', /vars\.RUNNER_DISK_MIN_BYTES/, `${id}: configurable disk reserve`);
  const checkpoint = steps.findIndex(step => /runner-disk\.mjs["\s]+before-cache/.test(step.run ?? ''));
  assert.ok(checkpoint >= 0, `${id}: checkpoint before large restores`);
  const restore = steps.findIndex(step => /actions\/(cache\/restore|download-artifact)@/.test(step.uses ?? ''));
  if (restore >= 0) assert.ok(checkpoint < restore, `${id}: cache/artifact restore ordering`);
  for (const step of heavySteps) {
    const wrapped = /runner-disk-shell\.sh \{0\}/.test(step.shell ?? '') || /node scripts\/runner-disk\.mjs .*node scripts\/backend-tests\.mjs/.test(step.run ?? '');
    assert.ok(wrapped, `${id}: monitor ${step.name ?? step.run.split('\n')[0]}`);
    assert.ok(steps.indexOf(step) > checkpoint, `${id}: initial checkpoint before heavy work`);
  }
  for (const [index, step] of steps.entries()) {
    if (!heavyAction(step)) continue;
    assert.match(steps[index - 1].run, /runner-disk\.mjs/, `${id}: guard action disk use`);
  }
  const evidence = steps.find(step => /actions\/upload-artifact@/.test(step.uses ?? '') && /\.cache\/runner-disk/.test(step.with?.path ?? ''));
  assert.ok(evidence, `${id}: durable disk evidence`);
  assert.equal(evidence.if, '${{ !cancelled() }}', `${id}: preserve failures`);
  assert.equal(evidence.with['include-hidden-files'], true);
  assert.equal(evidence.with['if-no-files-found'], 'error');
  if (job.strategy?.matrix) assert.match(evidence.with.name, /matrix\.|strategy\.job-index/, `${id}: independent matrix artifacts`);
}

let count = 0;
for (const [file, workflow] of workflows) {
  for (const [id, job] of Object.entries(workflow.jobs)) {
    if (!job.steps?.some(step => heavy.test(step.run ?? '') || heavyAction(step))) continue;
    count++;
    test(`${file}/${id} guards heavy work and retains failure evidence`, () => check(workflow, id, job));
  }
}
test('census discovers the database, browser, image and cache workflows', () => {
  assert.ok(count >= 20, `unexpectedly small census: ${count}`);
  for (const file of ['ci.yml', 'db-tests.yml', 'e2e-live.yml', 'route-load.yml', 'platform.yml', 'codeql.yml']) {
    assert.ok(workflows.find(([name, workflow]) => name === file && Object.values(workflow.jobs).some(job => job.steps?.some(step => heavy.test(step.run ?? '') || heavyAction(step)))), file);
  }
});

test('census rejects a new unguarded heavy job and missing failure uploads', () => {
  const workflow = {env: {RUNNER_DISK_MIN_BYTES: "${{ vars.RUNNER_DISK_MIN_BYTES || '2147483648' }}"}};
  assert.throws(() => check(workflow, 'new-build', {steps: [{run: 'cargo build --locked'}]}), /checkpoint/);
  const guarded = {steps: [{run: 'node scripts/runner-disk.mjs before-cache'}, {run: 'npm ci', shell: 'runner-disk-shell.sh {0}'}]};
  assert.throws(() => check(workflow, 'new-build', guarded), /durable disk evidence/);
});

test('census mutations cannot silently bypass monitoring or failure evidence', () => {
  const [file, workflow] = workflows.find(([file]) => file === 'e2e-live.yml');
  const original = workflow.jobs.chromium;
  const mutations = [
    job => { job.steps.find(step => heavy.test(step.run ?? '')).shell = 'bash'; },
    job => { job.steps.find(step => /before-cache/.test(step.run ?? '')).run = 'true'; },
    job => { job.steps.find(step => /runner-disk/.test(step.with?.path ?? '')).if = 'success()'; },
    job => { job.steps.find(step => /runner-disk/.test(step.with?.path ?? '')).with['include-hidden-files'] = false; },
    job => { job.steps.find(step => /runner-disk/.test(step.with?.path ?? '')).with.name = 'shared'; },
  ];
  for (const mutate of mutations) {
    const job = structuredClone(original);
    mutate(job);
    assert.throws(() => check(workflow, file, job));
  }
});
