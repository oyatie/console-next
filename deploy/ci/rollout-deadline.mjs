// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from 'node:assert/strict';

const refuse = message => `PLAT_ROLLOUT_DEADLINE: ${message}`;
function integer(value, name, minimum = 0) {
  assert.ok(Number.isSafeInteger(value) && value >= minimum, refuse(`${name} must be an integer >= ${minimum}`));
  return value;
}

function duration(value, name) {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(value ?? '');
  assert.ok(match, refuse(`${name} must be a finite duration in ms, s, m or h`));
  return Number(match[1]) * {ms:0.001, s:1, m:60, h:3600}[match[2]];
}

function probeBudget(probe, threshold) {
  if (!probe) return 0;
  // Kubernetes probe defaults are also recorded in the vendored Rollout CRD.
  const period = integer(probe.periodSeconds === undefined ? 10 : probe.periodSeconds, 'probe period', 1);
  const timeout = integer(probe.timeoutSeconds === undefined ? 1 : probe.timeoutSeconds, 'probe timeout', 1);
  const count = integer(probe[threshold] === undefined ? (threshold === 'failureThreshold' ? 3 : 1) : probe[threshold], threshold, 1);
  return integer(probe.initialDelaySeconds === undefined ? 0 : probe.initialDelaySeconds, 'probe initial delay') + count * Math.max(period, timeout);
}

function uniqueResource(resources, rollout, kind, name, apiVersion) {
  const matches = resources.filter(doc => doc.kind === kind && doc.metadata?.name === name
    && doc.metadata.namespace === rollout.metadata.namespace && (!apiVersion || doc.apiVersion === apiVersion));
  assert.equal(matches.length, 1, refuse(`expected one ${kind} ${name} in the Rollout namespace`));
  return matches[0];
}

export function rolloutAnalysisDurationSeconds(rollout, resources) {
  const canary = rollout.spec.strategy?.canary;
  assert.ok(canary && !canary.analysis, refuse('expected finite inline canary analysis'));
  let analysisSeconds = 0;
  for (const step of canary.steps ?? []) {
    if (!step.analysis) continue;
    const templates = step.analysis.templates;
    assert.ok(templates?.length, refuse('analysis must reference templates'));
    const budgets = templates.map(ref => {
      assert.ok(!ref.clusterScope, refuse('cluster analysis templates are not in the render snapshot'));
      const template = uniqueResource(resources, rollout, 'AnalysisTemplate', ref.templateName);
      const metrics = template.spec.metrics;
      assert.ok(metrics?.length, refuse('analysis must contain finite metrics'));
      return Math.max(...metrics.map(metric => {
        const count = integer(metric.count, 'analysis count', 1);
        const interval = duration(metric.interval, 'analysis interval');
        assert.ok(interval > 0, refuse('analysis interval must be positive'));
        return count * interval + duration(metric.initialDelay === undefined ? '0s' : metric.initialDelay, 'analysis initial delay');
      }));
    });
    analysisSeconds += Math.max(...budgets);
  }
  return analysisSeconds;
}

export function rolloutProgressDeadlineSeconds(rollout, resources, marginSeconds) {
  integer(marginSeconds, 'margin');
  const ref = rollout.spec.workloadRef;
  assert.ok(ref?.kind === 'Deployment' && ref.apiVersion === 'apps/v1', refuse('expected an apps/v1 Deployment workloadRef'));
  const deployment = uniqueResource(resources, rollout, ref.kind, ref.name, ref.apiVersion);
  const containers = deployment.spec.template.spec.containers;
  assert.ok(containers?.length, refuse('workload must contain containers'));
  const startupSeconds = Math.max(...containers.map(c => probeBudget(c.startupProbe, 'failureThreshold')));
  const readySeconds = Math.max(...containers.map(c => probeBudget(c.startupProbe, 'failureThreshold') + probeBudget(c.readinessProbe, 'successThreshold')))
    + integer(rollout.spec.minReadySeconds === undefined ? 0 : rollout.spec.minReadySeconds, 'minReadySeconds');
  const analysisSeconds = rolloutAnalysisDurationSeconds(rollout, resources);
  const deadline = integer(Math.ceil(readySeconds + analysisSeconds + marginSeconds), 'derived deadline', 1);
  assert.ok(deadline >= startupSeconds, refuse('derived deadline is below the startup budget'));
  return deadline;
}
