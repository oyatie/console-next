// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  assert.equal(rollout.spec.progressDeadlineAbort, true, 'shipped Rollout must abort stalled candidates');
  for (const environment of ['exit-test', 'template']) {
    const config = JSON.parse(read(`deploy/clusters/${environment}/platform.json`));
    assert.ok(Number.isSafeInteger(config.rolloutProgressDeadlineSeconds) && config.rolloutProgressDeadlineSeconds > 0);
  }
});

function canary(scenario = '', previousImage = `example.invalid/console@sha256:${'b'.repeat(64)}`) {
  const dir = mkdtempSync(join(tmpdir(), 'canary-abort-'));
  try {
    mkdirSync(join(dir, '.tmp/evidence'), {recursive:true});
    mkdirSync(join(dir, '.tmp/exit-bundle'), {recursive:true});
    mkdirSync(join(dir, 'deploy/ci'), {recursive:true});
    writeFileSync(join(dir, 'deploy/ci/diagnostics.mjs'), 'console.log("fault diagnostics");');
    const image = `example.invalid/console@sha256:${'a'.repeat(64)}`;
    writeFileSync(join(dir, '.tmp/exit-bundle/revision.json'), JSON.stringify({image, previousImage}));
    const docs = yaml.loadAll(read('deploy/base/app/api.yaml'));
    const deployment = docs.find(doc => doc.kind === 'Deployment');
    deployment.spec.template.spec.containers[0].image = image;
    deployment.metadata = {name:scenario === 'sidecar' ? 'referenced-api' : 'console-api', namespace:'console', generation:1};
    if (scenario === 'sidecar') deployment.spec.template.spec.containers.unshift({name:'sidecar', image:'existing-sidecar'});
    const rollout = docs.find(doc => doc.kind === 'Rollout');
    rollout.spec.workloadRef.name = deployment.metadata.name;
    rollout.spec.progressDeadlineSeconds = JSON.parse(read('deploy/clusters/exit-test/platform.json')).rolloutProgressDeadlineSeconds;
    rollout.metadata = {name:'console-api', namespace:'console', uid:'rollout-uid'};
    rollout.status = {phase:'Healthy', stableRS:'stable', currentPodHash:'stable', workloadObservedGeneration:1};
    const template = yaml.load(read('deploy/base/app/analysis.yaml'));
    writeFileSync(join(dir, 'state.json'), JSON.stringify({deployment, rollout, template, originalTemplate:template, image, analyses:[], calls:[], scenario}));
    writeFileSync(join(dir, 'kubectl'), `#!/usr/bin/env node
const fs = require('node:fs'), assert = require('node:assert/strict');
const state = JSON.parse(fs.readFileSync('state.json')), a = process.argv.slice(2);
state.calls.push(a);
const out = value => console.log(typeof value === 'string' ? value : JSON.stringify(value));
const app = () => state.deployment.spec.template.spec.containers.find(c => c.name === 'console');
const faulted = () => app().readinessProbe.httpGet.path.startsWith('/internal/');
const rs = hash => {
  const template = structuredClone(state.deployment.spec.template);
  const container = template.spec.containers.find(c => c.name === 'console');
  if (state.scenario === 'rs-image') container.image = 'unverified-image';
  if (state.scenario === 'rs-probe' || state.scenario === 'reused-hash') container.readinessProbe.httpGet.path = '/readyz';
  return {metadata:{name:'api-'+hash, labels:{'rollouts-pod-template-hash':hash}, ownerReferences:[{uid:'rollout-uid'}]}, spec:{replicas:2, template}, status:{readyReplicas:hash === 'stable' ? (state.scenario === 'stable-unavailable' ? 0 : 2) : 0}};
};
if (a[0] === 'config') out('kind-platform-fixture');
else if (a[0] === 'set') {
  assert.equal(a[2], 'deployment/'+state.deployment.metadata.name);
  app().image = a[3].split('=').slice(1).join('=');
  state.deployment.metadata.generation++;
  if (app().image === state.image && state.scenario !== 'no-promotion') state.analyses.push({metadata:{uid:'promotion'},status:{phase:'Successful'}});
} else if (a[0] === 'patch') {
  assert.equal(a[1], 'deployment', 'exit-test must use the shipped Rollout and analysis unchanged');
  assert.equal(a[2], state.deployment.metadata.name);
  const target = state.deployment;
  if (state.scenario === 'image-drift') app().image = 'concurrent-release';
  const patch = JSON.parse(a[a.indexOf('-p')+1]);
  assert.ok(a.includes('--type=json'), 'fault must use an atomic JSON patch');
  for (const p of patch) {
    const keys = p.path.slice(1).split('/'); let obj = target;
    for (const key of keys.slice(0,-1)) obj = obj[key];
    if (p.op === 'test') assert.deepEqual(obj[keys.at(-1)], p.value, 'verified image changed before fault injection'); else obj[keys.at(-1)] = p.value;
  }
  state.deployment.metadata.generation++;
  state.rollout.status.currentPodHash = state.scenario === 'reused-hash' ? 'stable' : 'fault';
} else if (a[0] === 'wait') {
  if (a.some(arg => arg.includes('status.abort'))) {
    if (faulted() && state.rollout.spec.progressDeadlineAbort && state.rollout.spec.progressDeadlineSeconds > 0 && state.scenario !== 'no-abort') {
      state.rollout.status.abort = true;
      state.rollout.status.phase = 'Degraded';
      state.rollout.status.conditions = [{type:'Progressing',status:'False',reason:'RolloutAborted',message:'Rollout aborted update to revision 5: ReplicaSet "api-fault" has timed out progressing.'}];
      if (state.scenario === 'wrong-abort') state.rollout.status.conditions[0].message = 'AnalysisRun error';
      if (state.scenario === 'stable-changed') state.rollout.status.stableRS = 'fault';
    } else { console.error('rollout abort timed out'); process.exitCode = 1; }
  }
  if (a.some(arg => arg.includes('readyReplicas')) && state.scenario === 'stable-unavailable') process.exitCode = 1;
} else if (a[0] === 'get') {
  if (a[1] === '--raw') out({status:state.scenario === 'stable-http-failed' ? 'not_ready' : 'ready'});
  else if (a[1] === 'deployment') { assert.equal(a[2], state.deployment.metadata.name); out(state.deployment); }
  else if (a[1] === 'rollout') out(state.rollout);
  else if (a[1] === 'analysisruns') out({items:state.analyses});
  else if (a[1] === 'analysistemplate') out(state.template);
  else if (['replicasets','rs'].includes(a[1])) out({items:[rs(a.join(' ').includes('fault') ? 'fault' : 'stable')]});
  else if (a[1] === 'replicaset') out(rs(a[2].endsWith('stable') ? 'stable' : 'fault'));
  else if (a[1] === 'pods') out({items:[{metadata:{name:'candidate'},status:{phase:'Running',conditions:[{type:'Ready',status:state.scenario === 'pod-ready' ? 'True' : 'False'}]}}]});
  else if (a[1] === 'service') out({spec:{selector:{'rollouts-pod-template-hash':state.scenario === 'service-misrouted' ? 'fault' : 'stable'},ports:[{name:'http',port:8080}]}});
  else throw new Error('unexpected get: '+a.join(' '));
} else throw new Error('unexpected command: '+a.join(' '));
fs.writeFileSync('state.json', JSON.stringify(state));
`, {mode:0o755});
    writeFileSync(join(dir, 'flux'), `#!/usr/bin/env node
const fs = require('node:fs'), state = JSON.parse(fs.readFileSync('state.json'));
state.calls.push(['flux', ...process.argv.slice(2)]);
if (process.argv[2] === 'resume') state.diagnosticsBeforeResume = fs.existsSync('.tmp/evidence/canary-diagnostics.txt');
fs.writeFileSync('state.json', JSON.stringify(state));
`, {mode:0o755});
    const result = spawnSync(process.execPath, [join(root, 'deploy/ci/canary.mjs')], {cwd:dir, encoding:'utf8', timeout:15000, env:{...process.env, PATH:`${dir}:${process.env.PATH}`}});
    const evidence = join(dir, '.tmp/evidence/canary-promotion.json');
    return {...result, state:JSON.parse(readFileSync(join(dir, 'state.json'))),
      promotion:existsSync(evidence) ? JSON.parse(readFileSync(evidence)) : null};
  } finally { rmSync(dir, {recursive:true,force:true}); }
}

test('fault reaches the referenced Deployment and named container; shipped deadline aborts while stable serves', () => {
  const result = canary();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.state.diagnosticsBeforeResume, true);
  assert.deepEqual(result.state.template.spec, result.state.originalTemplate.spec, 'normal promotion keeps its readiness analysis');
  assert.ok(!result.state.calls.some(call => ['create', 'apply', 'delete'].includes(call[0])), 'no test-only templates or tokens');
  const patches = result.state.calls.filter(call => call[0] === 'patch');
  assert.equal(patches.length, 1);
  assert.equal(patches[0][1], 'deployment');
  const patch = JSON.parse(patches[0][patches[0].indexOf('-p') + 1]);
  assert.deepEqual(patch[0], {op:'test',path:'/spec/template/spec/containers/0/image',value:result.state.image});
  assert.ok(result.state.calls.some(call => call.includes('--for=jsonpath={.status.abort}=true') && call.includes('--timeout=180s')));
});

test('fault follows workloadRef and application identity with a sidecar at container zero', () => {
  const result = canary('sidecar');
  assert.equal(result.status, 0, result.stderr);
});

test('first publish names the promotion skip and still proves the faulted-candidate abort', () => {
  const result = canary('', null);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /SKIP PLAT_NO_DISTINCT_PREVIOUS_IMAGE/);
  assert.equal(result.promotion.status, 'skipped');
  assert.equal(result.promotion.code, 'PLAT_NO_DISTINCT_PREVIOUS_IMAGE');
  assert.ok(!result.state.calls.some(call => call[0] === 'set'));
  assert.ok(result.state.calls.some(call => call[0] === 'patch'));
  assert.equal(result.state.rollout.status.abort, true);
  assert.equal(result.state.diagnosticsBeforeResume, true);
});

test('an identical previous image is invalid publisher evidence, never a promotion skip', () => {
  const result = canary('', `example.invalid/console@sha256:${'a'.repeat(64)}`);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /PLAT_PREVIOUS_RELEASE/);
  assert.doesNotMatch(result.stdout, /SKIP/);
});

test('an empty previous image is invalid publisher evidence, never a promotion skip', () => {
  const result = canary('', '');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /PLAT_PREVIOUS_RELEASE/);
  assert.doesNotMatch(result.stdout, /SKIP/);
});

for (const [scenario, message] of [
  ['no-promotion', /N-1 to N must run successful canary analysis/],
  ['no-abort', /rollout abort timed out/],
  ['image-drift', /verified image changed before fault injection/],
  ['reused-hash', /fault must produce a new candidate hash/],
  ['rs-image', /candidate must keep the verified image/],
  ['rs-probe', /candidate must carry the injected readiness fault/],
  ['pod-ready', /candidate must be unready/],
  ['wrong-abort', /candidate must abort on its readiness progress deadline/],
  ['stable-changed', /abort must preserve the stable ReplicaSet/],
  ['stable-unavailable', /readyReplicas/],
  ['service-misrouted', /stable Service must select the stable ReplicaSet/],
  ['stable-http-failed', /stable Service must still serve readyz/],
]) {
  test(`negative control refuses ${scenario} and preserves diagnostics before Flux restoration`, () => {
    const result = canary(scenario);
    assert.notEqual(result.status, 0, result.stderr);
    assert.match(result.stderr, message, 'fail at the responsible guard, not a later assertion');
    assert.equal(result.state.diagnosticsBeforeResume, true);
    assert.ok(result.state.calls.some(call => call[0] === 'flux' && call[1] === 'reconcile'));
  });
}
