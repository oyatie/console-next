// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
const run=(...args)=>execFileSync('kubectl',args,{encoding:'utf8'});
assert.match(run('config','current-context'),/^kind-platform-/);
const revision=JSON.parse(readFileSync('.tmp/exit-bundle/revision.json'));
assert.ok(revision.previousImage && revision.previousImage !== revision.image,'PLAT_PREVIOUS_RELEASE: the first dev push seeds N-1; another dev push is required to prove promotion');
const get=(kind,name)=>JSON.parse(run('get',kind,name,'-n','console','-o','json'));
const rollout=get('rollout','console-api');
const workload=rollout.spec.workloadRef;
assert.equal(workload.apiVersion,'apps/v1');assert.equal(workload.kind,'Deployment');
const deployment=()=>get('deployment',workload.name);
const container=deployment().spec.template.spec.containers.find(c=>c.image===revision.image);
assert.ok(container,'verified image must identify the application container');
const analysis=rollout.spec.strategy.canary.steps.find(step=>step.analysis).analysis;
const templateName=analysis.templates[0].templateName;
const originalTemplate=get('analysistemplate',templateName);
const secretName='console-canary-analysis';
const faultTemplateName=`${templateName}-abort`;
let negativeAnalysis=false;
function healthy() {
  const generation=deployment().metadata.generation;
  run('wait',`--for=jsonpath={.status.workloadObservedGeneration}=${generation}`,'rollout/console-api','-n','console','--timeout=180s');
  run('wait','--for=jsonpath={.status.phase}=Healthy','rollout/console-api','-n','console','--timeout=240s');
}
execFileSync('flux',['suspend','kustomization','console-app']);
try {
  run('set','image',`deployment/${workload.name}`,`${container.name}=${revision.previousImage}`,'-n','console');healthy();
  const before=new Set(JSON.parse(run('get','analysisruns','-n','console','-o','json')).items.map(r=>r.metadata.uid));
  run('set','image',`deployment/${workload.name}`,`${container.name}=${revision.image}`,'-n','console');healthy();
  const promoted=JSON.parse(run('get','analysisruns','-n','console','-o','json')).items.filter(r=>!before.has(r.metadata.uid) && r.status?.phase==='Successful');
  assert.ok(promoted.length,'N-1 to N must run successful canary analysis');
  writeFileSync('.tmp/evidence/canary-promotion.json',JSON.stringify(promoted,null,2));
  const stable=get('rollout','console-api').status.stableRS;
  const beforeFault=new Set(JSON.parse(run('get','analysisruns','-n','console','-o','json')).items.map(r=>r.metadata.uid));
  // /internal/ bypasses the SPA's HTTP 200 fallback. workloadRef reads this Deployment template.
  const faultPath='/internal/class-b-injected-fault';
  const index=deployment().spec.template.spec.containers.findIndex(c=>c.name===container.name);
  assert.ok(index>=0);
  run('patch','deployment',workload.name,'-n','console','--type=json','-p',JSON.stringify([
    {op:'test',path:`/spec/template/spec/containers/${index}/image`,value:revision.image},
    {op:'replace',path:`/spec/template/spec/containers/${index}/readinessProbe/httpGet/path`,value:faultPath},
  ]));
  const generation=deployment().metadata.generation;
  run('wait',`--for=jsonpath={.status.workloadObservedGeneration}=${generation}`,'rollout/console-api','-n','console','--timeout=180s');
  const candidate=get('rollout','console-api').status.currentPodHash;
  assert.ok(candidate && candidate!==stable,'fault must produce a new candidate hash');
  const selector=Object.entries({...rollout.spec.selector.matchLabels,'rollouts-pod-template-hash':candidate}).map(([k,v])=>`${k}=${v}`).join(',');
  const replicaSets=JSON.parse(run('get','replicasets','-n','console','-l',selector,'-o','json')).items;
  assert.equal(replicaSets.length,1);
  const actual=replicaSets[0].spec.template.spec.containers.find(c=>c.name===container.name);
  assert.equal(actual.image,revision.image);assert.equal(actual.readinessProbe.httpGet.path,faultPath);
  run('wait','--for=create','pod','-n','console','-l',selector,'--timeout=180s');
  run('wait','--for=jsonpath={.status.phase}=Running','pod','-n','console','-l',selector,'--timeout=180s');
  run('wait',`--for=jsonpath={.status.containerStatuses[?(@.name=="${container.name}")].started}=true`,'pod','-n','console','-l',selector,'--timeout=180s');
  const pods=JSON.parse(run('get','pods','-n','console','-l',selector,'-o','json')).items;
  assert.ok(pods.length);
  for (const pod of pods) assert.ok(pod.status.conditions.some(c=>c.type==='Ready' && c.status==='False'));
  writeFileSync('.tmp/evidence/canary-fault.json',JSON.stringify({generation,candidate,stable,workload:workload.name,container:container.name,image:actual.image,
    probe:actual.readinessProbe.httpGet,pods:pods.map(p=>({name:p.metadata.name,ready:p.status.conditions.find(c=>c.type==='Ready').status}))},null,2));
  // A background gate can measure an unready candidate before setWeight completes; HTTP 503 is a web-provider Error.
  const controller=JSON.parse(run('get','deployment','argo-rollouts','-n','argo-rollouts','-o','json'));
  const token=run('create','token',controller.spec.template.spec.serviceAccountName,'-n','argo-rollouts').trim();
  const spec=structuredClone(originalTemplate.spec);
  spec.args=[...(spec.args ?? []),{name:'api-token',valueFrom:{secretKeyRef:{name:secretName,key:'token'}}}];
  assert.equal(spec.metrics.length,1);
  const metric=spec.metrics[0];
  metric.successCondition="result == 'True'";metric.failureCondition="result == 'False'";
  metric.provider={web:{url:`https://kubernetes.default.svc/api/v1/namespaces/${rollout.metadata.namespace}/pods/${pods[0].metadata.name}`,
    insecure:true,jsonPath:'{$.status.conditions[?(@.type=="Ready")].status}',headers:[{key:'Authorization',value:'Bearer {{args.api-token}}'}]}};
  execFileSync('kubectl',['apply','-f','-'],{input:JSON.stringify({apiVersion:'v1',kind:'List',items:[
    {apiVersion:'v1',kind:'Secret',metadata:{name:secretName,namespace:'console'},stringData:{token}},
    {apiVersion:originalTemplate.apiVersion,kind:'AnalysisTemplate',metadata:{name:faultTemplateName,namespace:'console'},spec},
  ]}),encoding:'utf8'});
  negativeAnalysis=true;
  run('patch','rollout','console-api','-n','console','--type=merge','-p',JSON.stringify({spec:{strategy:{canary:{analysis:{...analysis,templates:[{templateName:faultTemplateName}]}}}}}));
  run('wait','--for=jsonpath={.status.abort}=true','rollout/console-api','-n','console','--timeout=180s');
  run('wait','--for=jsonpath={.status.phase}=Degraded','rollout/console-api','-n','console','--timeout=180s');
  const aborted=get('rollout','console-api');
  assert.equal(aborted.status.abort,true);
  assert.equal(aborted.status.phase,'Degraded');
  assert.equal(aborted.status.stableRS,stable);
  const failed=JSON.parse(run('get','analysisruns','-n','console','-o','json')).items.filter(r=>!beforeFault.has(r.metadata.uid)
    && r.metadata.labels?.['rollouts-pod-template-hash']===candidate && r.metadata.ownerReferences?.some(o=>o.uid===rollout.metadata.uid));
  assert.ok(failed.some(r=>r.status?.phase==='Failed' && r.status.metricResults?.some(m=>m.name===metric.name && m.failed>0
    && !m.error && m.measurements?.some(v=>v.phase==='Failed' && v.value==='"False"'))),'candidate must abort on measured Failed readiness, not Error or a deadline');
  writeFileSync('.tmp/evidence/canary-failed-analysis.json',JSON.stringify(failed,null,2));
  const stableSelector=Object.entries({...rollout.spec.selector.matchLabels,'rollouts-pod-template-hash':stable}).map(([k,v])=>`${k}=${v}`).join(',');
  const stableSets=JSON.parse(run('get','replicasets','-n','console','-l',stableSelector,'-o','json')).items;
  assert.equal(stableSets.length,1);
  run('wait',`--for=jsonpath={.status.readyReplicas}=${rollout.spec.replicas}`,`replicaset/${stableSets[0].metadata.name}`,'-n','console','--timeout=180s');
  const serviceName=rollout.spec.strategy.canary.stableService;
  const service=get('service',serviceName);
  assert.equal(service.spec.selector['rollouts-pod-template-hash'],stable);
  const port=service.spec.ports.find(p=>p.name===container.readinessProbe.httpGet.port);
  assert.ok(port);
  const ready=JSON.parse(run('get','--raw',`/api/v1/namespaces/${rollout.metadata.namespace}/services/http:${serviceName}:${port.port}/proxy${container.readinessProbe.httpGet.path}`));
  assert.equal(ready.status,'ready','stable Service must still serve readyz');
  writeFileSync('.tmp/evidence/canary-abort.json',JSON.stringify(aborted,null,2));
} finally {
  // Capture the fault before Flux restores the healthy template (and its earlier hash).
  const diagnostics=spawnSync(process.execPath,['deploy/ci/diagnostics.mjs'],{encoding:'utf8'});
  writeFileSync('.tmp/evidence/canary-diagnostics.txt',(diagnostics.stdout ?? '')+(diagnostics.stderr ?? ''));
  try {
    if (negativeAnalysis) run('patch','rollout','console-api','-n','console','--type=merge','-p',JSON.stringify({spec:{strategy:{canary:{analysis:rollout.spec.strategy.canary.analysis ?? null}}}}));
    run('delete',`analysistemplate/${faultTemplateName}`,`secret/${secretName}`,'-n','console','--ignore-not-found');
  } finally {
    execFileSync('flux',['resume','kustomization','console-app']);
    execFileSync('flux',['reconcile','kustomization','console-app','--timeout=240s']);
  }
}
