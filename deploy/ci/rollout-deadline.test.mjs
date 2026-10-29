// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import yaml from 'js-yaml';
import { rolloutProgressDeadlineSeconds } from './rollout-deadline.mjs';

function fixture() {
  const docs = yaml.loadAll(readFileSync(new URL('../base/app/api.yaml', import.meta.url), 'utf8'));
  docs.push(yaml.load(readFileSync(new URL('../base/app/analysis.yaml', import.meta.url), 'utf8')));
  const rollout = docs.find(doc => doc.kind === 'Rollout');
  const deployment = docs.find(doc => doc.kind === 'Deployment');
  return { docs, rollout, deployment, container: deployment.spec.template.spec.containers[0], metric: docs.at(-1).spec.metrics[0] };
}

test('deadline includes the shipped startup, readiness and analysis budgets plus only the supplied margin', () => {
  const { docs, rollout } = fixture();
  assert.equal(rolloutProgressDeadlineSeconds(rollout, docs, 0), 170);
  assert.equal(rolloutProgressDeadlineSeconds(rollout, docs, 7), 177);
});

test('changing manifest probes, readiness settle and analysis changes the same derived deadline', () => {
  const { docs, rollout, container, metric } = fixture();
  container.startupProbe.failureThreshold = 40;
  container.startupProbe.initialDelaySeconds = 3;
  container.readinessProbe.successThreshold = 2;
  container.readinessProbe.initialDelaySeconds = 4;
  rollout.spec.minReadySeconds = 8;
  metric.count = 4;
  metric.interval = '0.5m';
  metric.initialDelay = '2s';
  assert.equal(rolloutProgressDeadlineSeconds(rollout, docs, 6), 353);
});

test('workloadRef resolves the matching namespace and budgets the slowest container', () => {
  const { docs, rollout, deployment, container } = fixture();
  rollout.metadata.namespace = deployment.metadata.namespace = 'release';
  docs.at(-1).metadata.namespace = 'release';
  rollout.spec.workloadRef.name = deployment.metadata.name = 'renamed-api';
  const foreign = structuredClone(deployment);
  foreign.metadata.namespace = 'other';
  foreign.spec.template.spec.containers[0].startupProbe.failureThreshold = 1000;
  docs.unshift(foreign);
  const sidecar = structuredClone(container);
  sidecar.name = 'slow-sidecar';
  sidecar.startupProbe.failureThreshold = 60;
  deployment.spec.template.spec.containers.unshift(sidecar, {name:'no-probes'});
  assert.equal(rolloutProgressDeadlineSeconds(rollout, docs, 0), 320);
});

test('probe defaults, timeouts and fractional analysis seconds cannot understate the budget', () => {
  const { docs, rollout, container, metric } = fixture();
  container.startupProbe = {httpGet: container.startupProbe.httpGet};
  container.readinessProbe.timeoutSeconds = 7;
  metric.interval = '250ms';
  assert.equal(rolloutProgressDeadlineSeconds(rollout, docs, 0), 38);
});

test('analysis metrics and templates run in parallel; inline analysis steps run sequentially', () => {
  const { docs, rollout, metric } = fixture();
  docs.at(-1).spec.metrics.push({...metric, name:'slower', count:4});
  const other = structuredClone(docs.at(-1));
  other.metadata.name = 'other-ready';
  other.spec.metrics = [{...metric, count:5}];
  docs.push(other);
  const analysis = rollout.spec.strategy.canary.steps.find(step => step.analysis).analysis;
  analysis.templates.push({templateName:'other-ready'});
  rollout.spec.strategy.canary.steps.push({analysis: structuredClone(analysis)});
  assert.equal(rolloutProgressDeadlineSeconds(rollout, docs, 0), 205);
});

for (const margin of [undefined, null, -1, -200, 0.5, '5', Infinity, Number.MAX_SAFE_INTEGER]) {
  test(`PLAT_ROLLOUT_DEADLINE: refuses invalid or overflowing margin ${String(margin)}`, () => {
    const { docs, rollout } = fixture();
    assert.throws(() => rolloutProgressDeadlineSeconds(rollout, docs, margin), /PLAT_ROLLOUT_DEADLINE/);
  });
}

for (const [name, mutate] of [
  ['missing referenced workload', f => { f.rollout.spec.workloadRef.name = 'missing'; }],
  ['ambiguous referenced workload', f => { f.docs.push(structuredClone(f.deployment)); }],
  ['unsupported workload kind', f => { f.rollout.spec.workloadRef.kind = 'Job'; }],
  ['empty workload', f => { f.deployment.spec.template.spec.containers = []; }],
  ['invalid startup threshold', f => { f.container.startupProbe.failureThreshold = 0; }],
  ['invalid readiness period', f => { f.container.readinessProbe.periodSeconds = -1; }],
  ['invalid readiness settle', f => { f.rollout.spec.minReadySeconds = -1; }],
  ['missing analysis template', f => { f.docs.pop(); }],
  ['cluster analysis template', f => { f.rollout.spec.strategy.canary.steps[1].analysis.templates[0].clusterScope = true; }],
  ['empty analysis', f => { f.docs.at(-1).spec.metrics = []; }],
  ['empty template references', f => { f.rollout.spec.strategy.canary.steps[1].analysis.templates = []; }],
  ['background analysis', f => { f.rollout.spec.strategy.canary.analysis = {}; }],
  ['unbounded analysis', f => { delete f.metric.count; }],
  ['invalid analysis interval', f => { f.metric.interval = 'later'; }],
  ['missing analysis interval', f => { delete f.metric.interval; }],
  ['zero analysis interval', f => { f.metric.interval = '0s'; }],
  ['negative analysis delay', f => { f.metric.initialDelay = '-1s'; }],
]) {
  test(`PLAT_ROLLOUT_DEADLINE: refuses ${name} instead of under-budgeting`, () => {
    const f = fixture();
    mutate(f);
    assert.throws(() => rolloutProgressDeadlineSeconds(f.rollout, f.docs, 0), /PLAT_ROLLOUT_DEADLINE/);
  });
}
