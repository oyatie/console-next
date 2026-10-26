// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const run=(...args)=>execFileSync('kubectl',args,{encoding:'utf8'});
assert.match(run('config','current-context'),/^kind-platform-/);
const revision=JSON.parse(readFileSync('.tmp/exit-bundle/revision.json'));
assert.ok(revision.previousImage && revision.previousImage !== revision.image,'PLAT_PREVIOUS_RELEASE: the first dev push seeds N-1; another dev push is required to prove promotion');
function healthy() {
  const generation=JSON.parse(run('get','deployment','console-api','-n','console','-o','json')).metadata.generation;
  run('wait',`--for=jsonpath={.status.workloadObservedGeneration}=${generation}`,'rollout/console-api','-n','console','--timeout=180s');
  run('wait','--for=jsonpath={.status.phase}=Healthy','rollout/console-api','-n','console','--timeout=240s');
}
execFileSync('flux',['suspend','kustomization','console-app']);
try {
  run('set','image','deployment/console-api',`console=${revision.previousImage}`,'-n','console');healthy();
  const before=new Set(JSON.parse(run('get','analysisruns','-n','console','-o','json')).items.map(r=>r.metadata.uid));
  run('set','image','deployment/console-api',`console=${revision.image}`,'-n','console');healthy();
  const promoted=JSON.parse(run('get','analysisruns','-n','console','-o','json')).items.filter(r=>!before.has(r.metadata.uid) && r.status?.phase==='Successful');
  assert.ok(promoted.length,'N-1 to N must run successful canary analysis');
  writeFileSync('.tmp/evidence/canary-promotion.json',JSON.stringify(promoted,null,2));
  // Fault the candidate's readiness while keeping the verified image and healthy stable replica set.
  run('patch','rollout','console-api','-n','console','--type=merge','-p',JSON.stringify({spec:{progressDeadlineSeconds:60,progressDeadlineAbort:true}}));
  run('patch','deployment','console-api','-n','console','--type=json','-p',JSON.stringify([{op:'replace',path:'/spec/template/spec/containers/0/readinessProbe/httpGet/path',value:'/class-b-injected-fault'}]));
  run('wait','--for=jsonpath={.status.abort}=true','rollout/console-api','-n','console','--timeout=180s');
  const aborted=JSON.parse(run('get','rollout','console-api','-n','console','-o','json'));
  assert.equal(aborted.status.phase,'Degraded');
  writeFileSync('.tmp/evidence/canary-abort.json',JSON.stringify(aborted,null,2));
} finally {
  execFileSync('flux',['resume','kustomization','console-app']);
  execFileSync('flux',['reconcile','kustomization','console-app','--timeout=240s']);
}
