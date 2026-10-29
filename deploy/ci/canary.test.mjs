// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
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

function canary(scenario = '') {
  const dir = mkdtempSync(join(tmpdir(), 'canary-abort-'));
  try {
    mkdirSync(join(dir, '.tmp/evidence'), {recursive:true});
    mkdirSync(join(dir, '.tmp/exit-bundle'), {recursive:true});
    mkdirSync(join(dir, 'deploy/ci'), {recursive:true});
    writeFileSync(join(dir, 'deploy/ci/diagnostics.mjs'), 'console.log("fault diagnostics");');
    const image = `example.invalid/console@sha256:${'a'.repeat(64)}`;
    writeFileSync(join(dir, '.tmp/exit-bundle/revision.json'), JSON.stringify({image, previousImage:`example.invalid/console@sha256:${'b'.repeat(64)}`}));
    const docs = yaml.loadAll(read('deploy/base/app/api.yaml'));
    const deployment = docs.find(doc => doc.kind === 'Deployment');
    deployment.spec.template.spec.containers[0].image = image;
    deployment.metadata = {name:scenario === 'sidecar' ? 'referenced-api' : 'console-api', namespace:'console', generation:1};
    if (scenario === 'sidecar') deployment.spec.template.spec.containers.unshift({name:'sidecar', image:'existing-sidecar'});
    const rollout = docs.find(doc => doc.kind === 'Rollout');
    rollout.spec.workloadRef.name = deployment.metadata.name;
    rollout.metadata = {name:'console-api', namespace:'console', uid:'rollout-uid'};
    rollout.status = {phase:'Healthy', stableRS:'stable', currentPodHash:'stable', workloadObservedGeneration:1};
    const template = yaml.load(read('deploy/base/app/analysis.yaml'));
    writeFileSync(join(dir, 'state.json'), JSON.stringify({deployment, rollout, template, originalTemplate:template, image, analyses:[], calls:[], scenario}));
    writeFileSync(join(dir, 'kubectl'), `#!/usr/bin/env node
const fs = require('node:fs'), assert = require('node:assert/strict');
const state = JSON.parse(fs.readFileSync('state.json')), a = process.argv.slice(2);
state.calls.push(a);
const out = value => console.log(typeof value === 'string' ? value : JSON.stringify(value));
const merge = (target, source) => { for (const [key, value] of Object.entries(source)) { if (value && typeof value === 'object' && !Array.isArray(value)) merge(target[key] ??= {}, value); else target[key] = value; } };
const app = () => state.deployment.spec.template.spec.containers.find(c => c.name === 'console');
const faulted = () => app().readinessProbe.httpGet.path.startsWith('/internal/');
const rs = hash => ({metadata:{name:'api-'+hash, labels:{'rollouts-pod-template-hash':hash}, ownerReferences:[{uid:'rollout-uid'}]}, spec:{replicas:2, template:state.deployment.spec.template}, status:{readyReplicas:hash === 'stable' ? (state.scenario === 'stable-unavailable' ? 0 : 2) : 0}});
if (a[0] === 'config') out('kind-platform-fixture');
else if (a[0] === 'set') {
  assert.equal(a[2], 'deployment/'+state.deployment.metadata.name);
  app().image = a[3].split('=').slice(1).join('=');
  state.deployment.metadata.generation++;
  if (app().image === state.image) state.analyses.push({metadata:{uid:'promotion'},status:{phase:'Successful'}});
} else if (a[0] === 'patch') {
  const target = a[1] === 'deployment' ? state.deployment : a[1] === 'rollout' ? state.rollout : state.template;
  if (a[1] === 'deployment') assert.equal(a[2], state.deployment.metadata.name);
  const patch = JSON.parse(a[a.indexOf('-p')+1]);
  if (a.includes('--type=json')) for (const p of patch) {
    const keys = p.path.slice(1).split('/'); let obj = target;
    for (const key of keys.slice(0,-1)) obj = obj[key];
    if (p.op === 'test') assert.deepEqual(obj[keys.at(-1)], p.value); else obj[keys.at(-1)] = p.value;
  } else merge(target, patch);
  if (a[1] === 'deployment') {
    state.deployment.metadata.generation++;
    state.rollout.status.currentPodHash = state.scenario === 'reused-hash' ? 'stable' : 'fault';
  }
  if (state.rollout.spec.strategy.canary.analysis) {
    assert.ok(faulted(), 'the real probe must refuse the candidate');
    const metric = state.negativeTemplate.spec.metrics[0];
    const url = new URL(metric.provider.web.url);
    assert.equal(url.pathname, '/api/v1/namespaces/console/pods/candidate');
    assert.match(metric.provider.web.jsonPath, /Ready/);
    assert.equal(metric.failureLimit, 0); assert.equal(metric.count, 3); assert.equal(metric.interval, '5s');
    assert.equal(metric.successCondition, "result == 'True'"); assert.equal(metric.failureCondition, "result == 'False'");
    assert.match(metric.provider.web.headers[0].value, /args\./);
    const phase = state.scenario === 'analysis-error' ? 'Error' : 'Failed';
    state.analyses.push({metadata:{uid:'negative',labels:{'rollouts-pod-template-hash':'fault'},ownerReferences:[{uid:'rollout-uid'}]},status:{phase,metricResults:[{name:metric.name,phase,failed:phase==='Failed'?1:0,error:phase==='Error'?5:0,measurements:[{phase,value:'"False"'}]}]}});
    state.rollout.status.abort = state.scenario !== 'no-abort'; state.rollout.status.phase = 'Degraded';
  }
} else if (a[0] === 'wait') {
  if (a.some(arg => arg.includes('status.abort')) && !state.rollout.status.abort) process.exitCode = 1;
  if (a.some(arg => arg.includes('readyReplicas')) && state.scenario === 'stable-unavailable') process.exitCode = 1;
} else if (a[0] === 'create' && a[1] === 'token') out('fixture-controller-token');
else if (a[0] === 'apply') {
  const resources = JSON.parse(fs.readFileSync(0, 'utf8')).items;
  assert.equal(resources.find(r => r.kind === 'Secret').stringData.token, 'fixture-controller-token');
  state.negativeTemplate = resources.find(r => r.kind === 'AnalysisTemplate');
} else if (a[0] === 'get') {
  if (a[1] === '--raw') out({status:state.scenario === 'stable-http-failed' ? 'not_ready' : 'ready'});
  else if (a[1] === 'deployment' && a.includes('argo-rollouts')) out({spec:{template:{spec:{serviceAccountName:'argo-rollouts'}}}});
  else if (a[1] === 'deployment') { assert.equal(a[2], state.deployment.metadata.name); out(state.deployment); }
  else if (a[1] === 'rollout') out(state.rollout);
  else if (a[1] === 'analysisruns') out({items:state.analyses});
  else if (a[1] === 'analysistemplate') out(state.template);
  else if (['replicasets','rs'].includes(a[1])) out({items:[rs(a.join(' ').includes('fault') ? 'fault' : 'stable')]});
  else if (a[1] === 'replicaset') out(rs(a[2].endsWith('stable') ? 'stable' : 'fault'));
  else if (a[1] === 'pods') out({items:[{metadata:{name:'candidate'},status:{phase:'Running',conditions:[{type:'Ready',status:'False'}]}}]});
  else if (a[1] === 'service') out({spec:{selector:{'rollouts-pod-template-hash':'stable'},ports:[{name:'http',port:8080}]}});
  else throw new Error('unexpected get: '+a.join(' '));
} else if (a[0] !== 'delete') throw new Error('unexpected command: '+a.join(' '));
fs.writeFileSync('state.json', JSON.stringify(state));
`, {mode:0o755});
    writeFileSync(join(dir, 'flux'), `#!/usr/bin/env node
const fs = require('node:fs'), state = JSON.parse(fs.readFileSync('state.json'));
state.calls.push(['flux', ...process.argv.slice(2)]);
if (process.argv[2] === 'resume') state.diagnosticsBeforeResume = fs.existsSync('.tmp/evidence/canary-diagnostics.txt');
fs.writeFileSync('state.json', JSON.stringify(state));
`, {mode:0o755});
    const result = spawnSync(process.execPath, [join(root, 'deploy/ci/canary.mjs')], {cwd:dir, encoding:'utf8', timeout:15000, env:{...process.env, PATH:`${dir}:${process.env.PATH}`}});
    return {...result, state:JSON.parse(readFileSync(join(dir, 'state.json')))};
  } finally { rmSync(dir, {recursive:true,force:true}); }
}

test('fault reaches the referenced Deployment and named container; measured Failed aborts while stable serves', () => {
  const result = canary();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.state.diagnosticsBeforeResume, true);
  assert.deepEqual(result.state.template.spec, result.state.originalTemplate.spec, 'normal promotion keeps its readiness analysis');
  assert.equal(result.state.rollout.spec.strategy.canary.analysis, null, 'remove the temporary background gate');
  assert.ok(result.state.calls.some(call => call.includes('--for=jsonpath={.status.abort}=true') && call.includes('--timeout=180s')));
});

test('fault follows workloadRef and application identity with a sidecar at container zero', () => {
  const result = canary('sidecar');
  assert.equal(result.status, 0, result.stderr);
});

for (const scenario of ['no-abort', 'reused-hash', 'analysis-error', 'stable-unavailable', 'stable-http-failed']) {
  test(`negative control refuses ${scenario} and preserves diagnostics before Flux restoration`, () => {
    const result = canary(scenario);
    assert.notEqual(result.status, 0, result.stderr);
    assert.equal(result.state.diagnosticsBeforeResume, true);
    assert.ok(result.state.calls.some(call => call[0] === 'flux' && call[1] === 'reconcile'));
  });
}
