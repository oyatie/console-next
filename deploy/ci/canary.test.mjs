// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import yaml from 'js-yaml';

const root = resolve(process.env.PLATFORM_REPO_ROOT ?? '.');
const read = path => readFileSync(resolve(root, path), 'utf8');

test('canary analysis resolves its Service from the controller namespace without pinning the cluster domain', () => {
  const template = yaml.load(read('deploy/base/app/analysis.yaml'));
  const rollout = yaml.loadAll(read('deploy/base/app/api.yaml')).find(doc => doc.kind === 'Rollout');
  const services = yaml.loadAll(read('deploy/base/app/services.yaml'));
  const metric = template.spec.metrics.find(metric => metric.name === 'canary-ready');
  const analysis = rollout.spec.strategy.canary.steps.find(step => step.analysis).analysis;
  const namespace = analysis.args?.find(arg => arg.name === 'namespace');
  assert.equal(namespace?.valueFrom.fieldRef.fieldPath, 'metadata.namespace');
  assert.ok(template.spec.args.some(arg => arg.name === namespace.name));
  for (const name of ['console', 'alternate-release-namespace']) {
    const url = new URL(metric.provider.web.url.replace('{{args.namespace}}', name));
    const service = services.find(service => service.metadata.name === rollout.spec.strategy.canary.canaryService);
    assert.equal(url.hostname, `${service.metadata.name}.${name}.svc`);
    assert.equal(Number(url.port), service.spec.ports[0].port);
    const deployment = yaml.loadAll(read('deploy/base/app/api.yaml')).find(doc => doc.kind === 'Deployment');
    assert.equal(url.pathname, deployment.spec.template.spec.containers[0].readinessProbe.httpGet.path);
  }
  assert.equal(metric.failureLimit, 0);
  assert.equal(metric.count, 3);
  assert.equal(metric.interval, '5s');
});
