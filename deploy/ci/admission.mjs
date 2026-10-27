// SPDX-License-Identifier: LicenseRef-Proprietary
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import { pod, refusals } from './fixtures.mjs';
const kubectl = (...args) => execFileSync('kubectl', args, {encoding:'utf8'});
const context = kubectl('config','current-context').trim();
assert.match(context, /^kind-platform-/, 'PLAT_TEST_CONTEXT: only a throwaway platform kind cluster');
mkdirSync('.tmp/evidence', {recursive:true});
kubectl('apply','--dry-run=server','-f','deploy/policies/admission.yaml');
kubectl('apply','-f','deploy/policies/admission.yaml');
const namespace = {apiVersion:'v1',kind:'Namespace',metadata:{name:'platform-admission',labels:{'platform.console/enforce':'true','policy.sigstore.dev/exclude':'true'}}};
execFileSync('kubectl',['apply','-f','-'],{input:JSON.stringify(namespace)});
const generation = JSON.parse(kubectl('get','validatingadmissionpolicy','console-workloads','-o','json')).metadata.generation;
kubectl('wait',`--for=jsonpath={.status.observedGeneration}=${generation}`,'validatingadmissionpolicy/console-workloads','--timeout=60s');
const status = JSON.parse(kubectl('get','validatingadmissionpolicy','console-workloads','-o','json'));
assert.deepEqual(status.status?.typeChecking?.expressionWarnings ?? [], [], 'CEL must typecheck without warnings');
function check(value) {
  value.metadata.namespace = 'platform-admission';
  return spawnSync('kubectl',['create','--dry-run=server','-f','-'],{input:JSON.stringify(value),encoding:'utf8'});
}
// Type checking precedes enforcement of a new policy and binding in the API server.
const probe = pod(); refusals.PLAT_IMAGE_DIGEST(probe);
const deadline = Date.now() + 60_000;
for (;;) {
  const result = check(probe);
  if (result.status !== 0 && /PLAT_IMAGE_DIGEST/.test(result.stderr)) break;
  assert.ok(Date.now() < deadline, `PLAT_ADMISSION_READY: enforcement did not become active: ${result.stderr}`);
  await setTimeout(500);
}
const accepted = check(pod());
assert.equal(accepted.status,0,accepted.stderr);
const database = pod();
database.spec.containers[0].image = JSON.parse(readFileSync(new URL('../versions.json', import.meta.url))).images.postgres;
const tagged = check(database);
assert.equal(tagged.status,0,tagged.stderr);
for (const [code, mutate] of Object.entries(refusals)) {
  const fixture = pod(); mutate(fixture);
  const result = check(fixture);
  assert.notEqual(result.status,0,`${code}: unsafe pod was admitted`);
  assert.match(result.stderr,new RegExp(code),`${code}: unrelated failures are not evidence`);
  writeFileSync(`.tmp/evidence/${code}.txt`,result.stderr);
}
console.log('VAP: two positive dry-runs and eight exact-code refusals passed');
